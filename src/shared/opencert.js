// Parsing helpers for OpenCerts / OpenAttestation documents.
// Shared by the main process (CLI export) and the viewer UI (bundled by esbuild).

// Same fallback the opencerts.io website uses for v2 documents with a string $template.
const LEGACY_RENDERER_URL = "https://legacy.opencerts.io/";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const isWrappedV2 = (doc) => isObject(doc) && isObject(doc.data) && isObject(doc.signature);

const isWrappedV3 = (doc) => isObject(doc) && isObject(doc.openAttestationMetadata);

const isW3cVc = (doc) =>
  isObject(doc) && Array.isArray(doc["@context"]) && (doc.renderMethod !== undefined || doc.credentialSubject !== undefined);

// OA v2 salts every leaf value as "<uuid>:<type>:<value>".
const unsaltValue = (value) => {
  if (typeof value !== "string") return value;
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 0 || second < 0) return value;
  const type = value.slice(first + 1, second);
  const raw = value.slice(second + 1);
  switch (type) {
    case "string":
      return raw;
    case "number":
      return Number(raw);
    case "boolean":
      return raw === "true";
    case "null":
      return null;
    case "undefined":
      return undefined;
    default:
      return value;
  }
};

const unsalt = (data) => {
  if (Array.isArray(data)) return data.map(unsalt);
  if (isObject(data)) {
    const out = {};
    for (const [key, value] of Object.entries(data)) out[key] = unsalt(value);
    return out;
  }
  return unsaltValue(data);
};

const getData = (doc) => (isWrappedV2(doc) ? unsalt(doc.data) : doc);

const getRendererUrl = (doc) => {
  if (isWrappedV2(doc)) {
    const template = getData(doc).$template;
    return isObject(template) && template.url ? template.url : LEGACY_RENDERER_URL;
  }
  if (isWrappedV3(doc)) return doc.openAttestationMetadata.template && doc.openAttestationMetadata.template.url;
  if (isW3cVc(doc)) {
    const method = [doc.renderMethod].flat()[0];
    return method && method.id;
  }
  return undefined;
};

const describe = (doc) => {
  const data = getData(doc);
  const issuers = data.issuers || (data.issuer ? [data.issuer] : []);
  const issuerName = issuers
    .map((i) => (typeof i === "string" ? i : i.name || i.id))
    .filter(Boolean)
    .join(", ");
  const recipient = data.recipient || data.credentialSubject || {};
  return {
    schema: isWrappedV2(doc) ? "OpenAttestation v2" : isWrappedV3(doc) ? "OpenAttestation v3" : "W3C VC",
    name: data.name || (data.openAttestationMetadata && data.openAttestationMetadata.template && data.openAttestationMetadata.template.name) || "Certificate",
    issuer: issuerName || "Unknown issuer",
    recipient: recipient.name || "",
    issuedOn: data.issuedOn || data.validFrom || data.issuanceDate || "",
  };
};

// Returns { raw, data, rendererUrl, info } or throws with a user-facing message.
const parseOpenCert = (text) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error("This file is not valid JSON, so it can't be an .opencert file.");
  }
  if (!isWrappedV2(raw) && !isWrappedV3(raw) && !isW3cVc(raw)) {
    throw new Error("Unrecognised document format (expected an OpenAttestation v2/v3 or W3C VC document).");
  }
  const rendererUrl = getRendererUrl(raw);
  if (!rendererUrl) throw new Error("The document does not specify a renderer (template) URL.");
  let url;
  try {
    url = new URL(rendererUrl);
  } catch (e) {
    throw new Error(`The document's renderer URL is invalid: ${rendererUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported renderer URL: ${rendererUrl}`);
  }
  return { raw, data: getData(raw), rendererUrl: url.href, info: describe(raw) };
};

module.exports = { parseOpenCert, getData, getRendererUrl, LEGACY_RENDERER_URL };
