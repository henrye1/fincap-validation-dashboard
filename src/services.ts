/**
 * Hand-built dependencies for the audit. No Service registry resolution, no Express, no Core API:
 * every constructor argument the validation legs never touch is passed as `undefined`.
 *
 * Call buildDeps only after the default TypeORM connection is open — the reference-data and
 * risk-calculator services resolve their repositories through the global getRepository() at
 * construction time.
 */
import { Connection } from 'typeorm';
import { GoogleGenAI } from '@google/genai';
import { FinancialStatementReferenceDataService } from '@modules/financial-capture/services/financial-statement-reference-data-service';
import { FinancialStatementValidator } from '@modules/financial-capture/services/financial-statement-validator';
import { FinancialValidatorService } from '@modules/financial-capture/services/financial-validator-service';
import { FileProcessor } from '@modules/financial-capture/services/file-processor';
import { RiskCalcFinancialTranslator } from '@modules/financial-capture/services/translators/riskcalc-financial-translator';
import { FinancialStatementLineMapping } from '@modules/financial-capture/entities/FinancialStatementLineMapping';
import { FinancialStatementType } from '@modules/financial-capture/entities/FinancialStatementType';
import { FinancialStatementAccountType } from '@modules/financial-capture/entities/FinancialStatementAccountType';
import { FinancialInformationDatabaseService } from '@modules/risk-calculators';
import { RiskFinancialSchemaService } from '@shared/risk-financial-schema/risk-financial-schema.service';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** The validators ask for the catalogue on every statement; reference data does not change mid-run. */
export class CachedReferenceData extends FinancialStatementReferenceDataService {
    private types?: Promise<FinancialStatementType[]>;
    private accountTypes?: Promise<FinancialStatementAccountType[]>;
    private mappings = new Map<string, Promise<FinancialStatementLineMapping[]>>();

    async listFinancialStatementTypes(): Promise<FinancialStatementType[]> {
        if (!this.types) this.types = super.listFinancialStatementTypes();
        return this.types;
    }

    async listFinancialStatementAccountTypes(): Promise<FinancialStatementAccountType[]> {
        if (!this.accountTypes) this.accountTypes = super.listFinancialStatementAccountTypes();
        return this.accountTypes;
    }

    async listFinancialStatementLineMapping(company_typeId?: number, financial_statement_type_id?: string): Promise<FinancialStatementLineMapping[]> {
        const key = `${company_typeId ?? ''}|${financial_statement_type_id ?? ''}`;
        let cached = this.mappings.get(key);
        if (!cached) {
            cached = super.listFinancialStatementLineMapping(company_typeId, financial_statement_type_id);
            this.mappings.set(key, cached);
        }
        return cached;
    }
}

/** The one method of AIService the validation legs call, keyed from the environment instead of Core API. */
export interface GeminiLike {
    QueryGemini(contents: any[], systemInstruction?: string): Promise<string | undefined>;
}

export function geminiFromEnv(required: boolean): GeminiLike {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL_NAME || DEFAULT_GEMINI_MODEL;
    if (required && !apiKey) {
        throw new Error('--ai needs GEMINI_API_KEY (and optionally GEMINI_MODEL_NAME) in anchorpoint-ts/.env.secrets');
    }
    return {
        async QueryGemini(contents: any[], systemInstruction?: string): Promise<string | undefined> {
            if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model,
                contents,
                config: { temperature: 0, ...(systemInstruction ? { systemInstruction } : {}) },
            });
            return response.text;
        },
    };
}

export interface AuditDeps {
    connection: Connection;
    refData: CachedReferenceData;
    validator: FinancialStatementValidator;
    translator: RiskCalcFinancialTranslator;
    validatorService: FinancialValidatorService;
    geminiModel: string;
}

export function buildDeps(connection: Connection, ai: boolean): AuditDeps {
    const refData = new CachedReferenceData();
    const validator = new FinancialStatementValidator(refData);
    const translator = new RiskCalcFinancialTranslator(
        refData,
        new FinancialInformationDatabaseService(connection),
        new RiskFinancialSchemaService(),
    );
    // coreApiService is only used by the capture/OCR paths (the fetchSetting calls in file-processor.ts),
    // never by scanDocumentWithGemini or validateRatiosWithAi.
    const fileProcessor = new FileProcessor(undefined as any, geminiFromEnv(ai) as any, connection);
    // financialStatementService is only used by the client/book validations, not by the AI legs.
    const validatorService = new FinancialValidatorService(undefined as any, refData, connection, fileProcessor);
    return {
        connection,
        refData,
        validator,
        translator,
        validatorService,
        geminiModel: process.env.GEMINI_MODEL_NAME || DEFAULT_GEMINI_MODEL,
    };
}
