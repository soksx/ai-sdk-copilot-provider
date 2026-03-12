export type CopilotResponsesIncludeOptions =
	| Array<
			| "reasoning.encrypted_content"
			| "file_search_call.results"
			| "message.output_text.logprobs"
			| "web_search_call.action.sources"
			| "code_interpreter_call.outputs"
	  >
	| undefined
	| null;
