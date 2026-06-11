import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env.local"), override: true });
// Do NOT auto-load whatsapp-chatbot/.env. That file is easy to accidentally keep sandbox values in.
// Use whatsapp-chatbot/.env.local (or root .env.local) for local secrets instead.
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });
