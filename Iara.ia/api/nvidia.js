const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

const LEGACY_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MAX_MESSAGES = 80;
const MAX_MESSAGE_LENGTH = 190000;
const MAX_TOTAL_LENGTH = 220000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

function getApiKey(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return false;
  }

  let totalLength = 0;
  for (const message of messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      return false;
    }
    totalLength += message.content.length;
    if (totalLength > MAX_TOTAL_LENGTH) return false;
  }
  return true;
}

function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [first, second, third] = address.split(".").map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168 || (second === 88 && third === 99))) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

async function resolvePublicAddress(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, family: 4, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicIpv4(entry.address))) {
    throw new Error("O endereço do provedor não é um destino HTTPS público permitido.");
  }
  return addresses[0].address;
}

function parseProviderUrl(value, resource) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Informe um endpoint HTTPS válido e compatível com OpenAI Chat Completions.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port && url.port !== "443" ||
    url.search ||
    url.hash ||
    net.isIP(url.hostname) ||
    url.hostname === "localhost" ||
    /\.(local|localhost|internal|test)$/i.test(url.hostname)
  ) {
    throw new Error("Use um endpoint HTTPS público, sem credenciais, parâmetros ou endereço IP direto.");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = `${basePath}/${resource}`;
  if (endpointPath.length > 500) throw new Error("O caminho do endpoint é longo demais.");
  return { url, endpointPath };
}

function requestProvider({ url, endpointPath, address, method, apiKey, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      path: endpointPath,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: body?.stream ? "text/event-stream, application/json" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      lookup: (_hostname, _options, callback) => callback(null, address, 4)
    }, response => resolve({ request, response }));

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Tempo limite do provedor excedido.")));
    request.on("error", reject);
    if (signal) {
      if (signal.aborted) request.destroy(new Error("Solicitação cancelada."));
      else signal.addEventListener("abort", () => request.destroy(new Error("Solicitação cancelada.")), { once: true });
    }
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

async function collectResponse(response, limit = MAX_RESPONSE_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > limit) {
      response.destroy();
      throw new Error("A resposta do provedor excedeu o limite de tamanho.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const action = req.query.action;
  const isModelsRequest = action === "models" && req.method === "GET";
  const isChatRequest = action === "chat" && req.method === "POST";
  if (!isModelsRequest && !isChatRequest) {
    sendError(res, 404, "Rota de provedor desconhecida.");
    return;
  }

  const apiKey = getApiKey(req);
  if (!apiKey || apiKey.length > 4096) {
    sendError(res, 401, "Informe uma chave API válida.");
    return;
  }

  let requestBody = null;
  if (isChatRequest) {
    try {
      requestBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      sendError(res, 400, "O corpo da solicitação não contém JSON válido.");
      return;
    }
    if (
      !requestBody ||
      typeof requestBody.model !== "string" ||
      requestBody.model.length === 0 ||
      requestBody.model.length > 160 ||
      (requestBody.stream !== undefined && typeof requestBody.stream !== "boolean") ||
      (requestBody.max_tokens !== undefined && (!Number.isInteger(requestBody.max_tokens) || requestBody.max_tokens < 1 || requestBody.max_tokens > 1024)) ||
      !validateMessages(requestBody.messages)
    ) {
      sendError(res, 400, "A mensagem ou o modelo informado é inválido.");
      return;
    }
  }

  const baseUrl = isChatRequest
    ? requestBody.baseUrl
    : req.query.baseUrl || LEGACY_NVIDIA_BASE_URL;
  if (typeof baseUrl !== "string" || baseUrl.length > 500) {
    sendError(res, 400, "O endpoint do provedor é inválido.");
    return;
  }

  let parsedEndpoint;
  let address;
  try {
    parsedEndpoint = parseProviderUrl(baseUrl, isModelsRequest ? "models" : "chat/completions");
    address = await resolvePublicAddress(parsedEndpoint.url.hostname);
  } catch (error) {
    sendError(res, 400, error.message || "Não foi possível validar o endpoint do provedor.");
    return;
  }

  const controller = new AbortController();
  let upstreamRequest;
  const abortUpstream = () => controller.abort();
  req.on("aborted", abortUpstream);
  res.on("close", () => {
    if (!res.writableEnded) abortUpstream();
  });

  try {
    const upstream = await requestProvider({
      ...parsedEndpoint,
      address,
      method: isModelsRequest ? "GET" : "POST",
      apiKey,
      body: requestBody
        ? {
            model: requestBody.model,
            messages: requestBody.messages,
            max_tokens: requestBody.max_tokens || 1024,
            stream: requestBody.stream === true
          }
        : null,
      signal: controller.signal
    });
    upstreamRequest = upstream.request;
    const upstreamResponse = upstream.response;
    res.setHeader("X-Provider-Response", "true");
    res.status(upstreamResponse.statusCode || 502);
    res.setHeader("Content-Type", upstreamResponse.headers["content-type"] || "application/json");

    if (
      isChatRequest &&
      requestBody.stream === true &&
      upstreamResponse.statusCode >= 200 &&
      upstreamResponse.statusCode < 300 &&
      String(upstreamResponse.headers["content-type"] || "").toLowerCase().includes("text/event-stream")
    ) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      for await (const chunk of upstreamResponse) {
        if (controller.signal.aborted || res.destroyed) break;
        if (!res.write(chunk)) {
          await new Promise(resolve => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
        }
      }
      if (!res.destroyed) res.end();
      return;
    }

    res.send(await collectResponse(upstreamResponse));
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (error.message === "A resposta do provedor excedeu o limite de tamanho.") {
      sendError(res, 502, error.message);
      return;
    }
    if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
    sendError(res, 502, "Não foi possível conectar ao endpoint do provedor. Confira o domínio e tente novamente.");
  }
};

module.exports.isPublicIpv4 = isPublicIpv4;
