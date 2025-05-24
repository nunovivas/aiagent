// Centralized configuration for the AI Syllabus Summarizer app

export const SERPAPI_KEY_PATH = process.env.SERPAPI_KEY_PATH || 'serpapi.key';
export const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
export const LOG_DIR = process.env.LOG_DIR || 'src/app/log';
