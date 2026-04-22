export interface BioMCPError {
  code: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export function createError(
  code: string,
  message: string,
  suggestion?: string,
  details?: Record<string, unknown>
): BioMCPError {
  return { code, message, suggestion, details };
}

export const ErrorCodes = {
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  TIMEOUT: 'TIMEOUT',
  API_ERROR: 'API_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

export function formatError(error: unknown): BioMCPError {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('not found') || message.includes('does not exist')) {
      return createError(
        ErrorCodes.ENTITY_NOT_FOUND,
        error.message,
        'Check the entity ID using the search tool first. Example: use gene_search to find valid gene symbols.',
        { originalError: error.message }
      );
    }
    
    if (message.includes('timeout') || message.includes('abort')) {
      return createError(
        ErrorCodes.TIMEOUT,
        error.message,
        'The upstream API request timed out. Try requesting fewer sections or a smaller dataset.',
        { originalError: error.message }
      );
    }
    
    if (message.includes('401') || message.includes('403') || message.includes('unauthorized')) {
      return createError(
        ErrorCodes.AUTH_REQUIRED,
        'Authentication required',
        'Set the required API key in environment variables. Check the documentation for required keys.',
        { originalError: error.message }
      );
    }
    
    if (message.includes('429') || message.includes('rate limit')) {
      return createError(
        ErrorCodes.RATE_LIMIT,
        error.message,
        'Rate limit exceeded. Wait a moment before retrying, or add an API key for faster access.',
        { originalError: error.message }
      );
    }
    
    if (message.includes('network') || message.includes('fetch') || message.includes('connect')) {
      return createError(
        ErrorCodes.NETWORK_ERROR,
        error.message,
        'Check your internet connection and the upstream API status.',
        { originalError: error.message }
      );
    }
    
    return createError(
      ErrorCodes.API_ERROR,
      error.message,
      'An error occurred while fetching data. Try again or use a different query.',
      { originalError: error.message }
    );
  }
  
  if (typeof error === 'string') {
    return createError(
      ErrorCodes.INVALID_INPUT,
      error,
      'Check the input format and try again.',
      { originalError: error }
    );
  }
  
  return createError(
    ErrorCodes.API_ERROR,
    'An unknown error occurred',
    'Try again with a different query or check the documentation.',
    { originalError: String(error) }
  );
}

export function withErrorHandling<T>(
  fn: () => Promise<T>,
  operationName?: string
): Promise<{ data?: T; error?: BioMCPError }> {
  return fn()
    .then(data => ({ data }))
    .catch(error => {
      const biomcpError = formatError(error);
      if (operationName) {
        biomcpError.message = `${operationName}: ${biomcpError.message}`;
      }
      return { error: biomcpError };
    });
}