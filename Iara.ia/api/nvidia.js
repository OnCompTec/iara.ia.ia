const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MAX_MESSAGES = 80;
const MAX_MESSAGE_LENGTH = 190000;
const MAX_TOTAL_LENGTH = 220000;

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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const action = req.query.action;
  const isModelsRequest = action === "models" && req.method === "GET";
  const isChatRequest = action === "chat" && req.method === "POST";
  if (!isModelsRequest && !isChatRequest) {
    sendError(res, 404, "Rota NVIDIA desconhecida.");
    return;
  }

  const apiKey = getApiKey(req);
  if (!apiKey || apiKey.length > 4096) {
    sendError(res, 401, "Informe uma chave NVIDIA válida nas configurações.");
    return;
  }

  let endpoint = `${NVIDIA_BASE_URL}/models`;
  let shouldStream = false;
  let requestOptions = {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` }
  };

  if (isChatRequest) {
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      sendError(res, 400, "O corpo da solicitação não contém JSON válido.");
      return;
    }
    if (
      !body ||
      typeof body.model !== "string" ||
      body.model.length === 0 ||
      body.model.length > 160 ||
      (body.stream !== undefined && typeof body.stream !== "boolean") ||
      !validateMessages(body.messages)
    ) {
      sendError(res, 400, "A mensagem ou o modelo informado é inválido.");
      return;
    }
    shouldStream = body.stream === true;
    endpoint = `${NVIDIA_BASE_URL}/chat/completions`;
    requestOptions = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        max_tokens: 1024,
        stream: shouldStream
      })
    };
  }

  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  req.on("aborted", abortUpstream);
  res.on("close", () => {
    if (!res.writableEnded) abortUpstream();
  });

  try {
    const response = await fetch(endpoint, { ...requestOptions, signal: controller.signal });
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    if (isChatRequest && shouldStream && response.ok && response.body) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      const reader = response.body.getReader();
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise(resolve => {
              res.once("drain", resolve);
              res.once("close", resolve);
            });
          }
        }
      } finally {
        if (controller.signal.aborted) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!res.destroyed) res.end();
      return;
    }

    res.send(await response.text());
  } catch {
    if (controller.signal.aborted || res.destroyed) return;
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message: "A conexão com a NVIDIA foi interrompida." } })}\n\n`);
      res.end();
      return;
    }
    sendError(res, 502, "A função da Vercel não conseguiu se conectar à NVIDIA.");
  }
};
