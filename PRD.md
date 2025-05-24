# Product Requirements Document (PRD)

| ReqID | Description | User Story | Expected Behaviour/Outcome |
|-------|-------------|------------|----------------------------|
| FR1 | Syllabus input and UI | As a user, I want to paste a Portuguese syllabus and generate a summary, so I can study the main topics in English. | User can paste syllabus, click "Generate Summary", see status updates, clear input, and view the summary. |
| FR2 | Topic extraction by line | As a user, I want each line of my syllabus to be treated as a topic, so I have full control over the topics. | The backend splits the syllabus by line; each non-empty line is a topic. No LLM topic extraction is used. |
| FR3 | Topic translation | As a user, I want each topic to be translated to English using an LLM, so the web search and summary are in English. | Each topic is translated to English by the LLM before web scraping. |
| FR4 | Web scraping per topic (10,000+ words) | As a user, I want the app to collect at least 10,000 words of web content for each topic, so the summary is comprehensive. | For each topic, the backend scrapes the web using SerpAPI, accumulates at least 10,000 words, and saves all source links. |
| FR5 | Per-topic summarization with sources | As a user, I want each topic to be summarized individually in English, with all sources listed in a separate paragraph. | Each topic's web content is summarized by the LLM, and the summary ends with a "Sources:" section listing all links. |
| FR6 | Summary display as tabs | As a user, I want to see each topic as a tab, with its summary and sources clearly separated. | The UI displays a tab for each topic, with summary and all sources below, all styled for readability. |
| FR7 | Live status and streaming | As a user, I want to see live status updates while the summary is being generated. | The UI shows the latest backend status, and the summary updates live as it streams in. |
| FR8 | Error handling and per-submission logging | As a user, I want to be informed of errors, and as a developer, I want all actions logged per submission. | Errors are shown in the UI; each backend submission creates a unique log file in `src/app/log/` (ollama-summary-<id>.txt). |
| NFR1 | Modern tech stack | As a developer, I want the app to use Next.js, TypeScript, Tailwind, and Node.js backend. | The app is built with the specified stack and is modern, responsive, and accessible. |
| NFR2 | No PDF generation | As a user, I want the summary as a webpage, not a PDF. | The summary is rendered as a professional webpage only. |
| NFR3 | Tested and reliable | As a user, I want the app to work reliably. | All code changes are tested and confirmed working. |
| NFR4 | API key security | As a developer, I want the SerpAPI key to be stored securely. | The SerpAPI key is stored in a separate `serpapi.key` file, not in source code. |
| SG1 | (Stretch) More topics | As a user, I want to summarize more than 4 topics. | The app can be configured to support more topics. |
| SG2 | (Stretch) Download options | As a user, I want to download the summary as PDF or other formats. | Option to export/download the summary. |
| SG3 | (Stretch) Customization | As a user, I want to customize summary style or language. | User can choose summary style or output language. |

_Updated: 2025-05-24_
