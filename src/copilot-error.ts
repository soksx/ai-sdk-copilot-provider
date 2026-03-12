import { z } from "zod";

export const copilotErrorDataSchema = z.object({
	error: z.object({
		message: z.string(),
		type: z.string().nullish(),
		param: z.any().nullish(),
		code: z.union([z.string(), z.number()]).nullish(),
	}),
});

export type CopilotErrorData = z.infer<typeof copilotErrorDataSchema>;

export type ProviderErrorStructure<T> = {
	errorSchema: z.ZodType<T>;
	errorToMessage: (error: T) => string;
	isRetryable?: (response: Response, error?: T) => boolean;
};

export const defaultCopilotErrorStructure: ProviderErrorStructure<CopilotErrorData> = {
	errorSchema: copilotErrorDataSchema,
	errorToMessage: (data) => data.error.message,
};
