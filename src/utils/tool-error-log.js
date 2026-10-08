const knownCodes = new Set([
  'expired_token', 'invalid_token', 'insufficient_scope', 'ACCESS_DENIED',
  'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
  'ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
]);

// Never log error messages, response bodies, arguments, headers or URLs: each
// can contain credentials or business data. Tool is the internal handler name.
export function logToolError(tool, error, write = line => console.error(line)) {
  const upstream = error.response?.data?.error;
  const code = error.b24?.code || (typeof upstream === 'object' ? upstream?.code : upstream) || error.code;
  const status = error.httpStatus ?? error.response?.status;
  write(JSON.stringify({
    event: 'mcp_tool_error',
    tool,
    code: knownCodes.has(code) ? code : 'unclassified',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}),
  }));
}
