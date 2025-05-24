import { NextRequest, NextResponse } from 'next/server';
import fetch from 'node-fetch';
import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
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

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function summarizeWithOllama(text: string): Promise<string> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        //old prompt prompt: `Summarize the following text which might be in html and related web data in clear, professional English prose. Only output the summary itself—do not include any meta tags, social media links, your own thoughts, or commentary. Do not list findings or use bullet points. Do not mention the source website except in the Sources section. Limit to 1-2 paragraphs. Only use the human readable text.\n\n${text}`,
        prompt:`You are a web content extraction assistant.\n Given the full raw HTML source of a web page, extract ONLY the **main readable article or relevant textual content** — no ads, headers, footers, sidebars, navigation, or scripts.\n Then **summarize** that extracted content clearly and concisely in a few paragraphs.\n DO NOT include any metadata, HTML, code, titles, URLs, disclaimers, or explanations. Output ONLY the clean, summarized main content as plain text.\nHere is the HTML: ${text}`,
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

async function translateTopicWithOllama(topic: string): Promise<string> {
  const models = ['llama3.2:latest', 'llama3.1:latest'];
  for (const model of models) {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `Translate the following topic from Any language to English. Only return the English translation, nothing else.\n\n${topic}`,
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
      let allLinks: string[] = [];
      let allSearchedLinks: string[] = [];
      let linkSummaries: { url: string, summary: string }[] = [];
      let tries = 0;
      // Keep scraping until we have at least 10,000 words or 10 URLs (but limit to 5 URLs for summarization)
      while (allLinks.length < 5 && tries < 10) {
        const urls = await searchWeb(translated);
        // Add all searched links (even if not fetched), but limit to 5
        for (const url of urls) {
          if (allSearchedLinks.length < 5 && !allSearchedLinks.includes(url)) {
            allSearchedLinks.push(url);
          }
        }
        let newContentAdded = false;
        for (const url of urls) {
          if (allLinks.length < 5 && !allLinks.includes(url)) {
            const content = await fetchWebContent(url);
            if (content) {
              logToFile(`Fetched content from ${url}`);
              logToFile(`Summarizing link: ${url}\nContent fed to LLM (first 500 chars):\n${content.slice(0, 500)}\n---END OF FEED---`);
              const linkSummary = await summarizeWithOllama(content);
              logToFile(`Summary for link ${url}:\n${linkSummary}\n---END OF LINK SUMMARY---`);
              linkSummaries.push({ url, summary: linkSummary });
              allLinks.push(url);
              newContentAdded = true;
            }
          }
        }
        tries++;
      }
      // Now summarize all link summaries for this topic
      const allSummariesText = linkSummaries.map(ls => ls.summary).join('\n\n');
      logToFile(`Summarizing all link summaries for topic: ${translated}\nContent fed to LLM (first 500 chars):\n${allSummariesText.slice(0, 500)}\n---END OF FEED---`);
      pushStatus(`Summarizing all link summaries for topic ${i + 1} of ${topics.length}...`);
      const topicSummary = await summarizeWithOllama(allSummariesText);
      logToFile(`Final topic summary for ${translated}:\n${topicSummary}\n---END OF TOPIC SUMMARY---`);
      topicResults.push({ topic, translated, sources: allSearchedLinks, content: allSummariesText, summary: topicSummary });
    }
    stream.push(encoder.encode('SUMMARY:' + JSON.stringify(
      topicResults.map(({ topic, translated, summary, sources }) => ({
        topic,
        translated,
        summary,
        sources
      }))
    )));
    stream.push(null);
    return;
  })();
  return new Response(toWebStream(stream), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
