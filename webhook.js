const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const OpenAI = require("openai");

// 1. Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 2. Constants
const TEMP_FILE_PATH = "/tmp/company_data.json"; 
const ASSISTANT_NAME = "Company Email Assistant";
const INSTRUCTIONS = "You are an AI that writes professional email responses using company-specific data.";
const MODEL = "gpt-4o";

let vectorStoreIdCache = null;

// 3. Download the JSON file from a public URL
async function downloadCompanyFile() {
  const fileUrl = "https://openai-agent.vercel.app/company_data.json";
  console.log(`Downloading company data from ${fileUrl}...`);

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const fileStream = fs.createWriteStream(TEMP_FILE_PATH);
  return new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

// 4. Upload the file to OpenAI & create a vector store
async function uploadCompanyFile() {
  if (vectorStoreIdCache) {
    console.log(`Using cached vector store: ${vectorStoreIdCache}`);
    return vectorStoreIdCache;
  }

  await downloadCompanyFile();

  console.log("Uploading company data file...");
  const file = await openai.files.create({
    file: fs.createReadStream(TEMP_FILE_PATH),
    purpose: "assistants"
  });
  console.log(`File uploaded successfully: ${file.id}`);

  const vectorStore = await openai.beta.vectorStores.create({
    name: "Company Knowledge Base",
    file_ids: [file.id]
  });
  console.log(`Vector store created: ${vectorStore.id}`);

  vectorStoreIdCache = vectorStore.id;
  return vectorStore.id;
}

// 5. Get or create the Assistant
async function getOrCreateAssistant(vectorStoreId) {
  console.log("Checking for existing Assistant...");
  const assistants = await openai.beta.assistants.list();
  let assistant = assistants.data.find(a => a.name === ASSISTANT_NAME);

  if (!assistant) {
    console.log("Creating new Assistant...");
    assistant = await openai.beta.assistants.create({
      name: ASSISTANT_NAME,
      instructions: INSTRUCTIONS,
      model: MODEL,
      tools: [{ type: "file_search" }]
    });
  }

  console.log(`Using Assistant: ${assistant.id}`);
  return { assistantId: assistant.id, vectorStoreId };
}

// 6. Generate a reply to an email
async function generateReply(emailContent) {
  try {
    const vectorStoreId = await uploadCompanyFile();
    const { assistantId } = await getOrCreateAssistant(vectorStoreId);

    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: `Here is an email I received:\n\n${emailContent}\n\nPlease write a professional and accurate reply, ensuring to use company-specific details if relevant.`
    });

    console.log("Generating response...");
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } }
    });

    let runStatus;
    do {
      await new Promise(resolve => setTimeout(resolve, 2000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      console.log(`Run status: ${runStatus.status}`);
    } while (runStatus.status !== "completed");

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find(msg => msg.role === "assistant");
    if (!assistantMessage) {
      throw new Error("No response from Assistant.");
    }

    // The content might be an array of structured segments or a single string
    if (Array.isArray(assistantMessage.content)) {
      return assistantMessage.content.map(item => item.text.value).join("\n");
    } else {
      return assistantMessage.content;
    }

  } catch (error) {
    console.error("Error generating reply:", error);
    throw new Error("Failed to generate a response.");
  }
}

// 7. Express server
const app = express();
app.use(express.json());

// POST endpoint
app.post("/", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Missing email content" });
  }

  try {
    const reply = await generateReply(email);
    res.status(200).json({ reply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Listen on the default Cyclic port or 3000
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
