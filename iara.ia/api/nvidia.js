const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MAX_MESSAGES = 80;
const MAX_MESSAGE_LENGTH = 30000;
const MAX_TOTAL_LENGTH = 100000;

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
      !validateMessages(body.messages)
    ) {
      sendError(res, 400, "A mensagem ou o modelo informado é inválido.");
      return;
    }
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
        stream: false
      })
    };
  }

  try {
    const response = await fetch(endpoint, requestOptions);
    const responseBody = await response.text();
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.send(responseBody);
  } catch {
    sendError(res, 502, "A função da Vercel não conseguiu se conectar à NVIDIA.");
  }
};
