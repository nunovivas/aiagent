import { NextRequest, NextResponse } from 'next/server';
import fetch from 'node-fetch';
import { writeFileSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
// @ts-ignore
import fontkit from '@pdf-lib/fontkit';
import { SERPAPI_KEY_PATH, OLLAMA_API_URL, LOG_DIR } from '../../config';
import * as cheerio from 'cheerio';

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
    const html = await res.text();
    // Use cheerio to extract only visible, relevant text from HTML
    const $ = cheerio.load(html);
    // Remove unwanted tags
    $('script, style, noscript, head, meta, link, title, iframe, svg, canvas, nav, footer, form, input, button, aside, header, object, embed, select, option, textarea, label, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], [hidden]').remove();
    // Remove elements with display:none or visibility:hidden
    $('[style*="display:none"], [style*="visibility:hidden"]').remove();
    // Remove elements with class or id that are likely to be non-content
    $('[class*="nav"], [class*="footer"], [class*="header"], [class*="sidebar"], [id*="nav"], [id*="footer"], [id*="header"], [id*="sidebar"]').remove();
    // Get main content text
    let text = '';
    // Try to get <main> content if present, else fallback to <body>
    if ($('main').length) {
      text = $('main').text();
    } else {
      text = $('body').text();
    }
    // Collapse whitespace, remove excessive blank lines, trim
    const content = text.replace(/\s+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 2000);
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
        prompt: `Summarize the following college course syllabus topic and related web data in clear, professional English prose. Only output the summary itself—do not include any meta tags, social media links, your own thoughts, or commentary. Do not list findings or use bullet points. Do not mention the source website except in the Sources section. Limit to 1-2 paragraphs.Also if you receive an HTML text, dont analyse the HTML but only the human readable text it contains. You should only return the Summary. No comments or any kind of conversation.\n\n${text}`,
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
      let lastContentLength = 0;
      // Keep scraping until we have at least 10,000 words or 10 URLs
      while (allContent.split(/\s+/).length < 10000 && tries < 10) {
        const urls = await searchWeb(translated);
        let newContentAdded = false;
        for (const url of urls) {
          if (!allLinks.includes(url)) {
            const content = await fetchWebContent(url);
            if (content) {
              allContent += ' ' + content;
              allLinks.push(url);
              newContentAdded = true;
              logToFile(`Fetched content from ${url}`);
            }
          }
        }
        tries++;
        // If no new content was added, break to avoid infinite loop
        if (!newContentAdded) break;
      }
      // Limit content to 10,000 words
      const contentWords = allContent.split(/\s+/);
      if (contentWords.length > 10000) {
        allContent = contentWords.slice(0, 10000).join(' ');
      }
      // Summarize the collected content for the topic
      logToFile(`Summarizing topic: ${translated}\nContent fed to LLM (first 500 chars):\n${allContent.slice(0, 500)}\n---END OF FEED---`);
      pushStatus(`Summarizing content for topic ${i + 1} of ${topics.length}...`);
      const summary = await summarizeWithOllama(allContent);
      topicResults.push({ topic, translated, sources: allLinks, content: allContent, summary });
    }
    pushStatus('Generating final summary document...');
    // Generate a final summary document as a JSON array for tabbed UI
    const summaryArray = topicResults.map(({ topic, translated, sources, content, summary }) => ({
      topic,
      translated,
      summary,
      sources
    }));
    const finalSummary = JSON.stringify(summaryArray);
    // If requested, stream the response
    if (isStatusStream) {
      stream.push(encoder.encode('SUMMARY:' + finalSummary));
      stream.push(null);
    } else {
      return NextResponse.json({ summary: finalSummary });
    }
  })().catch(err => {
    console.error('Error processing request:', err);
    stream.push(encoder.encode('ERROR:An error occurred while processing your request.'));
    stream.push(null);
  });
  return new Response(toWebStream(stream), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
  });
}
