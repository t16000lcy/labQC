const { answerFromHybrid } = require("./hybrid-search");

async function answerFromKnowledge(message, mode = "education") {
  return answerFromHybrid(message, mode);
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { message, mode } = request.body || {};
  if (!message || !String(message).trim()) {
    response.status(400).json({ error: "message is required" });
    return;
  }

  response.status(200).json(await answerFromKnowledge(String(message).trim(), mode));
};

module.exports.answerFromKnowledge = answerFromKnowledge;
