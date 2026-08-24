import type { IStructuredError, IQueryResult, IResultMetadata } from '../interface/index.js';

const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE',
  'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE',
];

const READ_ONLY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'WITH'];

const WRITE_TARGET_REGEX = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

export interface ValidationResult {
  valid: boolean;
  error?: IQueryResult;
}

export function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

function isReadOnlyShape(trimmedSql: string): boolean {
  const upper = trimmedSql.toUpperCase();
  return READ_ONLY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function validateReadOnlyQuery(sql: string, backendType: string): ValidationResult {
  const trimmed = sql.trim();

  if (!trimmed) {
    return {
      valid: false,
      error: createValidationError(
        'EMPTY_QUERY',
        'SQL query cannot be empty',
        ['Provide a valid SELECT query'],
        backendType
      ),
    };
  }

  if (trimmed.includes(';')) {
    return {
      valid: false,
      error: createValidationError(
        'MULTIPLE_STATEMENTS',
        'Multiple SQL statements are not allowed (semicolon detected)',
        ['Remove the semicolon and use only one SELECT statement'],
        backendType
      ),
    };
  }

  if (!isReadOnlyShape(trimmed)) {
    return {
      valid: false,
      error: createValidationError(
        'NOT_READ_ONLY',
        `Only ${READ_ONLY_PREFIXES.join(', ')} queries are allowed. This toolkit is read-only.`,
        ['Use a SELECT statement to query data'],
        backendType
      ),
    };
  }

  const stripped = stripStringLiterals(trimmed);

  if (WRITE_TARGET_REGEX.test(stripped)) {
    return {
      valid: false,
      error: createValidationError(
        'FORBIDDEN_KEYWORD',
        'INTO OUTFILE/DUMPFILE is not allowed. This toolkit is read-only.',
        ['Remove the INTO OUTFILE/DUMPFILE clause'],
        backendType
      ),
    };
  }

  const upperStripped = stripped.toUpperCase();

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(upperStripped)) {
      return {
        valid: false,
        error: createValidationError(
          'FORBIDDEN_KEYWORD',
          `Forbidden keyword detected: ${keyword}. This toolkit is read-only.`,
          ['Remove the forbidden keyword', 'Only read-only queries are permitted'],
          backendType
        ),
      };
    }
  }

  return { valid: true };
}

export function validateCollectionName(name: string, backendType: string): ValidationResult {
  const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  if (!name || !name.trim()) {
    return {
      valid: false,
      error: createValidationError(
        'EMPTY_COLLECTION_NAME',
        'Collection/table name cannot be empty',
        ['Provide a valid collection/table name', 'Use db_list_tables to see available tables'],
        backendType
      ),
    };
  }

  if (!TABLE_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error: createValidationError(
        'INVALID_COLLECTION_NAME',
        `Invalid collection/table name format: '${name}'`,
        [
          'Names must start with a letter or underscore',
          'Names can only contain letters, numbers, and underscores',
          'Use db_list_tables to see valid names',
        ],
        backendType
      ),
    };
  }

  return { valid: true };
}

function createValidationError(
  code: string,
  message: string,
  hints: string[],
  backendType: string
): IQueryResult {
  const error: IStructuredError = {
    code,
    message,
    hints,
  };

  const metadata: IResultMetadata = {
    executionTimeMs: 0,
    backend: backendType,
  };

  return {
    success: false,
    error,
    metadata,
  };
}

export const ERROR_HINTS = {
  CONNECTION: [
    'Check that the database server is running',
    'Verify DB_HOST and DB_PORT environment variables',
    'Ensure network connectivity to the database',
  ],
  AUTH: [
    'Verify DB_USER and DB_PASSWORD environment variables',
    'Check that the user has permissions for the database',
  ],
  MISSING_DEPENDENCY: [
    'Install the required driver package listed in the error message',
    'Drivers are optional peer dependencies and must be installed explicitly',
  ],
  UNKNOWN_TABLE: [
    'Use db_list_tables to see available tables/views',
    'Check the table name for typos',
  ],
  UNKNOWN_COLUMN: [
    'Use db_describe_table to see available columns',
    'Check the column name for typos',
  ],
  SYNTAX: [
    'Check your SQL syntax',
    'Ensure all identifiers are properly quoted if needed',
  ],
  SQLITE_FILE: [
    'Verify DB_SQLITE_PATH points to an existing database file',
    'Check that the file is a valid SQLite database',
    'This toolkit opens databases in read-only mode',
  ],
  GENERIC: [
    'Check your query syntax',
    'Use db_list_tables to see available tables/views',
    'Use db_describe_table to check column names',
  ],
} as const;

const ERROR_HINT_MAP: Record<string, readonly string[]> = {
  ECONNREFUSED: ERROR_HINTS.CONNECTION,
  ETIMEDOUT: ERROR_HINTS.CONNECTION,
  ENOTFOUND: ERROR_HINTS.CONNECTION,
  ER_ACCESS_DENIED_ERROR: ERROR_HINTS.AUTH,
  ER_BAD_DB_ERROR: ERROR_HINTS.AUTH,
  ER_NO_SUCH_TABLE: ERROR_HINTS.UNKNOWN_TABLE,
  ER_BAD_TABLE_ERROR: ERROR_HINTS.UNKNOWN_TABLE,
  ER_BAD_FIELD_ERROR: ERROR_HINTS.UNKNOWN_COLUMN,
  ER_UNKNOWN_COLUMN: ERROR_HINTS.UNKNOWN_COLUMN,
  ER_PARSE_ERROR: ERROR_HINTS.SYNTAX,
  ER_SYNTAX_ERROR: ERROR_HINTS.SYNTAX,
  ERR_MODULE_NOT_FOUND: ERROR_HINTS.MISSING_DEPENDENCY,
  SQLITE_CANTOPEN: ERROR_HINTS.SQLITE_FILE,
  SQLITE_NOTADB: ERROR_HINTS.SQLITE_FILE,
};

export function getErrorHints(errorCode: string | undefined): readonly string[] {
  return ERROR_HINT_MAP[errorCode ?? ''] ?? ERROR_HINTS.GENERIC;
}
