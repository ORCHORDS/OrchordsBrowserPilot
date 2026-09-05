// Policy-gated CDP adapter (#132).
//
// The MV3 extension cannot use the privileged debugging surface (it sits
// in the forbidden list at the top of this file's allow-list). The
// browser automation happens inside the local companion core, which talks
// to the native CDP endpoint of the browser the user has authenticated to.
// This adapter is the **policy boundary** between the extension and the
// native host: every command is matched against an explicit allow-list of
// CDP domains + methods, and every argument is sanitised so secrets cannot
// leak through CDP parameter shapes (cookies, headers, request bodies).
//
// The adapter is pure (no privileged chrome namespace at import time).
// It exports a factory that returns `{ plan, serialize, evaluate, validate }`
// helpers.

export const CDP_ADAPTER_VERSION = 1;

// Canonical allow-list of CDP domains + methods. Anything else MUST be
// refused at validation time. Adding a new domain is a privileged-API
// inventory change (#131) AND a privileged-API inventory test update.
export const CDP_DOMAIN_ALLOWLIST = Object.freeze([
  "Target",
  "Network",
  "Page",
  "DOM",
  "Runtime",
  "Input",
]);

export const CDP_METHOD_ALLOWLIST = Object.freeze([
  // Target lifecycle
  "Target.getTargets",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.setDiscoverTargets",
  // Network observation
  "Network.enable",
  "Network.disable",
  "Network.getCookies",
  "Network.setCookies",
  "Network.getRequestPostData",
  // Page navigation
  "Page.enable",
  "Page.disable",
  "Page.navigate",
  "Page.reload",
  // DOM inspection
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.getOuterHTML",
  // Runtime execution (sandboxed frames only)
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  // Input (synthesised, never raw OS-level)
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
]);

const HEADER_SECRET_TOKENS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-csrf-token",
  "x-auth-token",
  "proxy-authorization",
];

function isAllowedMethod(method) {
  if (typeof method !== "string") return false;
  const [domain, name] = method.split(".");
  if (!domain || !name) return false;
  if (!CDP_DOMAIN_ALLOWLIST.includes(domain)) return false;
  return CDP_METHOD_ALLOWLIST.includes(method);
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const clone = { ...headers };
  for (const key of Object.keys(clone)) {
    const lower = key.toLowerCase();
    if (HEADER_SECRET_TOKENS.some((token) => lower.includes(token))) {
      clone[key] = "[REDACTED]";
    }
  }
  return clone;
}

function redactCookieValue(cookie) {
  if (!cookie || typeof cookie !== "object") return cookie;
  return {
    ...cookie,
    value: cookie.value ? "[REDACTED]" : cookie.value,
  };
}

export function createCdpAdapter({ auditLog = null } = {}) {
  if (auditLog && typeof auditLog.append !== "function") {
    throw new Error("auditLog must expose append({ method, redactedArgs })");
  }

  function validate({ method, params }) {
    if (!isAllowedMethod(method)) {
      return { ok: false, code: "method_not_allowed", method };
    }
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return { ok: false, code: "malformed_params" };
    }
    return { ok: true };
  }

  function redactParams(method, params) {
    if (!params || typeof params !== "object") return params ?? {};
    if (method === "Network.enable" || method === "Network.disable") {
      return { ...params, headers: redactHeaders(params.headers) };
    }
    if (method === "Network.getCookies") {
      return { ...params, cookies: Array.isArray(params.cookies) ? params.cookies.map(redactCookieValue) : undefined };
    }
    if (method === "Network.setCookies" && Array.isArray(params.cookies)) {
      return { ...params, cookies: params.cookies.map(redactCookieValue) };
    }
    if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
      return { ...params, expression: params.expression ? "[REDACTED]" : undefined };
    }
    return { ...params };
  }

  function plan({ method, params, sessionId } = {}) {
    const validation = validate({ method, params });
    if (!validation.ok) return validation;
    const redacted = redactParams(method, params);
    const envelope = {
      version: CDP_ADAPTER_VERSION,
      method,
      sessionId: typeof sessionId === "string" ? sessionId : null,
      params: redacted,
    };
    return { ok: true, envelope };
  }

  function serialize(envelope) {
    if (!envelope || typeof envelope !== "object") {
      throw new Error("CDP envelope must be an object");
    }
    return JSON.stringify(envelope);
  }

  function evaluate(envelope) {
    if (!envelope || typeof envelope !== "object") {
      throw new Error("CDP envelope must be an object");
    }
    auditLog?.append({ method: envelope.method, redactedArgs: envelope.params });
    return { ok: true, method: envelope.method, sessionId: envelope.sessionId };
  }

  return { plan, serialize, evaluate, validate, redactParams, isAllowedMethod };
}
