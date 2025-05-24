import { NextRequest, NextResponse } from 'next/server';
import fetch from 'node-fetch';
import { writeFileSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
// @ts-ignore
import fontkit from '@pdf-lib/fontkit';
import { SERPAPI_KEY_PATH, OLLAMA_API_URL, LOG_DIR } from '../../config';

export const runtime = 'nodejs';

// Helper to convert Node.js Readable to Web ReadableStream
function toWebStream(nodeStream: Readable): ReadableStream<any> {
  return new ReadableStream({
    async pull(controller) {
      for await (const chunk of nodeStream) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      controller.close();
    }
  });
}

// Uses SerpAPI Web Search instead of Bing
async function searchWeb(query: string): Promise<string[]> {
  let apiKey = '';
  try {
    apiKey = readFileSync(join(process.cwd(), SERPAPI_KEY_PATH), 'utf8').trim();
  } catch (e) {
    console.error('SerpAPI key file not found or unreadable:', e);
    return [];
  }
  const endpoint = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&num=10&api_key=${apiKey}`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    console.error('SerpAPI error:', res.status, await res.text());
    return [];
  }
  type SerpApiResponse = {
    organic_results?: Array<{ link?: string }>;

  };
  const data: SerpApiResponse = await res.json() as any;
  // Extract URLs from organic_results
  const urls: string[] = [];
  if (Array.isArray(data.organic_results)) {
    for (const item of data.organic_results) {
      if (item.link) urls.push(item.link);
    }
  }
  return urls;
}

async function fetchWebContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return '';
    const text = await res.text();
    // Simple extraction: get first 2000 chars
    const content = text.replace(/\s+/g, ' ').slice(0, 2000);
    return content;
  } catch (err) {
    clearTimeout(timeout);
    return '';
  }
}

function extractBulletPoints(text: string): string[] {
  // Split by newlines, filter out empty lines, and trim
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && /^[0-9a-zA-Z\-•*]/.test(line));
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchWebForEachBullet(bullets: string[]): Promise<{ bullet: string, url: string, content: string }[]> {
  const results: { bullet: string, url: string, content: string }[] = [];
  for (const bullet of bullets) {
    const urls = await searchWeb(bullet);
    if (urls.length === 0) {
      results.push({ bullet, url: '', content: '' });
      await delay(1500); // Add delay between requests
      continue;
    }
    // Fix: Only push the first url/content per bullet, not multiple times
    const url = urls[0];
    const content = await fetchWebContent(url);
    results.push({ bullet, url, content });
    await delay(1500); // Add delay between requests
  }
  return results;
}

async function summarizeWithOllamaBullets(syllabus: string, bulletResults: { bullet: string, url: string, content: string }[]): Promise<string> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  let prompt = `Given the following college course syllabus (in Portuguese) and web search results for each topic, write a study summary in English, organized by the bullet points in the syllabus. For each bullet, summarize the web content and provide the source link. Limit to 3 pages.\n\nSyllabus:\n${syllabus}\n\nWeb results by bullet:`;
  for (const { bullet, url, content } of bulletResults) {
    prompt += `\n\nBullet: ${bullet}\nURL: ${url}\nContent: ${content}`;
  }
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      })
    });
    const data = await response.json();
    const summary = (typeof data === 'object' && data && 'response' in data && typeof data.response === 'string') ? data.response : '';
    if (summary.trim()) {
      return summary;
    }
  }
  return 'No summary generated.';
}

async function extractTopicsWithOllama(syllabus: string): Promise<string[]> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  const prompt = `Given the following college course syllabus (in Portuguese), extract and return a JSON array of the main topics or bullet points, in Portuguese. Only return the JSON array, nothing else.\n\nSyllabus:\n${syllabus}`;
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false })
    });
    const data = await response.json();
    const text = (typeof data === 'object' && data && 'response' in data && typeof data.response === 'string') ? data.response : '';
    try {
      const jsonStart = text.indexOf('[');
      const jsonEnd = text.lastIndexOf(']') + 1;
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const arr = JSON.parse(text.slice(jsonStart, jsonEnd));
        if (Array.isArray(arr)) return arr.map((t: any) => String(t));
      }
    } catch (e) {
    }
  }
  return [];
}

// Add this helper to summarize a single topic
async function summarizeWithOllama(text: string): Promise<string> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `Summarize the following college course syllabus topic and related web data in English, for study purposes. Limit to 1-2 paragraphs.\n\n${text}`,
        stream: false
      })
    });
    const data = await response.json();
    if (typeof data === 'object' && data && 'response' in data && typeof data.response === 'string' && data.response.trim()) {
      return data.response;
    }
  }
  return 'No summary generated.';
}

// Helper: Translate a topic to English using LLM
async function translateTopicWithOllama(topic: string): Promise<string> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `Translate the following college course topic from Portuguese to English. Only return the English translation, nothing else.\n\n${topic}`,
        stream: false
      })
    });
    const data = await response.json();
    if (typeof data === 'object' && data && 'response' in data && typeof data.response === 'string' && data.response.trim()) {
      return data.response.trim();
    }
  }
  return topic; // fallback: return original if translation fails
}

export async function POST(req: NextRequest) {
  const isStatusStream = req.headers.get('x-status-stream') === 'true';
  const formData = await req.formData();
  const syllabus = formData.get('syllabus');
  if (!syllabus || typeof syllabus !== 'string') {
    return NextResponse.json({ error: 'Missing syllabus' }, { status: 400 });
  }
  // Create a unique log file for each submission in the log folder
  const logDir = join(process.cwd(), LOG_DIR);
  try { require('fs').mkdirSync(logDir, { recursive: true }); } catch {}
  const submissionId = Date.now() + '-' + Math.floor(Math.random() * 100000);
  const logPath = join(logDir, `ollama-summary-${submissionId}.txt`);
  function logToFile(message: string) {
    appendFileSync(logPath, `\n[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8' });
  }
  logToFile('Received new request. Syllabus: ' + syllabus);
  const encoder = new TextEncoder();
  const stream = new Readable({
    read() {}
  });
  // Return a streaming response
  (async () => {
    let lastStatus = '';
    function pushStatus(status: string) {
      if (status !== lastStatus) {
        stream.push(encoder.encode('STATUS:' + status + '\n'));
        lastStatus = status;
      }
    }
    pushStatus('Splitting syllabus into topics...');
    // Split by line, trim, filter empty
    let topics = syllabus.split(/\n+/).map(t => t.trim()).filter(Boolean);
    if (topics.length === 0) {
      stream.push(encoder.encode('SUMMARY:No topics found.'));
      stream.push(null);
      return;
    }
    pushStatus('Translating topics to English...');
    // Translate each topic to English using LLM
    const translatedTopics: string[] = [];
    for (const [i, topic] of topics.entries()) {
      pushStatus(`Translating topic ${i + 1} of ${topics.length}`);
      const translated = await translateTopicWithOllama(topic);
      translatedTopics.push(translated);
    }
    pushStatus('Extracted and translated topics. Scraping the web for each topic...');
    // For each topic, scrape the web to get at least 10,000 words and collect all source links
    const topicResults: { topic: string, translated: string, sources: string[], content: string, summary: string }[] = [];
    for (const [i, topic] of topics.entries()) {
      const translated = translatedTopics[i];
      pushStatus(`Scraping for topic ${i + 1} of ${topics.length}: ${translated}`);
      let allContent = '';
      let allLinks: string[] = [];
      let tries = 0;
      // Keep scraping until we have at least 10,000 words or 10 URLs
      while (allContent.split(/\s+/).length < 10000 && tries < 10) {
        const urls = await searchWeb(translated);
        for (const url of urls) {
          if (!allLinks.includes(url)) {
            const content = await fetchWebContent(url);
            if (content && content.length > 0) {
              allContent += ' ' + content;
              allLinks.push(url);
            }
          }
        }
        tries++;
      }
      // Summarize the collected content for the topic
      pushStatus(`Summarizing content for topic ${i + 1} of ${topics.length}`);
      const summary = await summarizeWithOllama(allContent);
      // Append sources as a separate paragraph
      const summaryWithSources = allLinks.length
        ? summary.trim() + '\n\nSources:\n' + allLinks.join('\n')
        : summary.trim();
      topicResults.push({ topic, translated, sources: allLinks, content: allContent, summary: summaryWithSources });
      console.log('Links for topic', i + 1, ':', allLinks);
    }
    pushStatus('Generating final summary with bullet points...');
    // Instead of generating a single summary, send per-topic summaries as JSON array
    stream.push(encoder.encode('SUMMARY:' + JSON.stringify(topicResults)));
    stream.push(null);
  })();
  return new NextResponse(toWebStream(stream), {
    headers: { 'Content-Type': 'application/octet-stream' }
  });
}
