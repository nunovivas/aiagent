'use client';

import React, { useState } from 'react';
import { FaPalette, FaMoon, FaLeaf } from 'react-icons/fa';

const THEMES = [
	{
		name: 'Classic Blue',
		icon: <FaPalette title='Classic Blue' />, // blue palette icon
		bg: 'bg-gradient-to-br from-blue-50 to-white',
		card: 'bg-white border-blue-100',
		text: 'text-blue-900',
		accent: 'bg-blue-600 text-white hover:bg-blue-700',
		tabActive: 'bg-white border-blue-600 text-blue-900',
		tabInactive:
			'bg-blue-100 border-transparent text-blue-700 hover:bg-blue-200',
	},
	{
		name: 'Elegant Dark',
		icon: <FaMoon title='Elegant Dark' />, // moon icon
		bg: 'bg-gradient-to-br from-gray-900 to-gray-700',
		card: 'bg-gray-800 border-gray-700',
		text: 'text-white',
		accent: 'bg-purple-600 text-white hover:bg-purple-700',
		tabActive: 'bg-gray-900 border-purple-400 text-purple-200',
		tabInactive:
			'bg-gray-700 border-transparent text-purple-200 hover:bg-gray-600',
	},
	{
		name: 'Modern Green',
		icon: <FaLeaf title='Modern Green' />, // leaf icon
		bg: 'bg-gradient-to-br from-green-50 to-white',
		card: 'bg-white border-green-100',
		text: 'text-green-900',
		accent: 'bg-green-600 text-white hover:bg-green-700',
		tabActive: 'bg-white border-green-600 text-green-900',
		tabInactive:
			'bg-green-100 border-transparent text-green-700 hover:bg-green-200',
	},
];

export default function Home() {
	const [themeIdx, setThemeIdx] = useState(0);
	const theme = THEMES[themeIdx];
	const [syllabus, setSyllabus] = useState('');
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [summary, setSummary] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setLoading(true);
		setStatus('Starting...');
		setError(null);
		setSummary(null);
		try {
			const formData = new FormData();
			formData.append('syllabus', syllabus);
			const response = await fetch('/api/summarize', {
				method: 'POST',
				body: formData,
				headers: { 'x-status-stream': 'true' },
			});
			if (!response.body) throw new Error('No response body');
			const reader = response.body.getReader();
			let decoder = new TextDecoder();
			let lastStatus = '';
			let summaryText = '';
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				const text = decoder.decode(value, { stream: true });
				// Split on newlines in case multiple events are received at once
				for (const chunk of text.split(/\r?\n/)) {
					if (!chunk) continue;
					if (chunk.startsWith('STATUS:')) {
						lastStatus = chunk.replace('STATUS:', '').trim();
						setStatus(lastStatus);
					} else if (chunk.startsWith('SUMMARY:')) {
						summaryText += chunk.replace('SUMMARY:', '');
					} else {
						summaryText += chunk;
					}
				}
			}
			if (summaryText.trim()) {
				setSummary(summaryText.trim());
			} else {
				throw new Error('No summary received');
			}
		} catch (err: any) {
			setError(err.message || 'Unknown error');
		} finally {
			setLoading(false);
			setStatus(null);
		}
	};

	const handleClear = () => {
		setSyllabus('');
		setSummary(null);
		setError(null);
		setStatus(null);
	};

	return (
		<main
			className={`flex min-h-screen flex-col items-center justify-center p-4 ${theme.bg}`}
		>
			<div className={`flex justify-end gap-2 w-full max-w-2xl mt-4 mb-2`}>
				{THEMES.map((t, i) => (
					<button
						key={t.name}
						className={`p-2 rounded-full border transition-colors duration-150 text-xl flex items-center justify-center shadow-sm ${
							i === themeIdx
								? theme.accent
								: 'bg-gray-200 text-gray-700 hover:bg-gray-300'
						}`}
						onClick={() => setThemeIdx(i)}
						type='button'
						aria-label={t.name}
					>
						{t.icon}
					</button>
				))}
			</div>
			<div
				className={`w-full max-w-2xl ${theme.card} rounded-lg shadow-md p-8`}
			>
				<h1
					className={`text-3xl font-extrabold mb-4 text-center ${theme.text} tracking-tight`}
				>
					AI Syllabus Summarizer
				</h1>
				<p className={`mb-6 text-gray-700 text-center text-lg`}>
					Paste the syllabus in Portuguese. The app will search the web and return
					a professional English summary for study.
				</p>
				<form className='flex flex-col gap-4' onSubmit={handleSubmit}>
					<textarea
						name='syllabus'
						value={syllabus}
						onChange={(e) => setSyllabus(e.target.value)}
						placeholder='Paste here the topics you wish to summarize (em português)...'
						className='border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 min-h-[120px] resize-vertical text-base'
						required
						disabled={loading}
					/>
					<div className='flex gap-2'>
						<button
							type='submit'
							className={`${theme.accent} rounded px-4 py-2 font-semibold transition flex-1`}
							disabled={loading || !syllabus.trim()}
						>
							{loading ? 'Generating Summary...' : 'Generate Summary'}
						</button>
						<button
							type='button'
							className='bg-gray-200 text-gray-700 rounded px-4 py-2 font-semibold hover:bg-gray-300 transition flex-1'
							onClick={handleClear}
							disabled={loading || !syllabus.trim()}
						>
							Clear
						</button>
					</div>
				</form>
				{loading && status && (
					<div className='mt-4 text-blue-600 text-center animate-pulse'>
						{status}
					</div>
				)}
				{error && (
					<div className='mt-4 text-red-600 text-center'>{error}</div>
				)}
				{summary && <SummaryDisplay summary={summary} theme={theme} />}
			</div>
		</main>
	);
}

function SummaryDisplay({
	summary,
	theme,
}: {
	summary: string;
	theme: any;
}) {
	// Expect summary as a JSON array of topics
	let parsed: any[] = [];
	try {
		const parsedJson = JSON.parse(summary);
		// Defensive: ensure parsedJson is always an array
		parsed = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
	} catch {
		// fallback: show as plain text
		return (
			<div
				className={`prose max-w-none mx-auto ${theme.bg} p-8 rounded-xl border ${theme.card} shadow-lg mt-8`}
			>
				<pre>{summary}</pre>
			</div>
		);
	}
	const [activeTab, setActiveTab] = useState(0);
	return (
		<div
			className={`prose max-w-none mx-auto ${theme.bg} p-8 rounded-xl border ${theme.card} shadow-lg mt-8`}
		>
			<div className='flex flex-wrap gap-2 mb-8'>
				{parsed.map((section, i) => (
					<button
						key={i}
						className={`px-4 py-2 rounded-t font-semibold border-b-2 transition-colors duration-150 ${
							activeTab === i
								? theme.tabActive
								: theme.tabInactive
						}`}
						onClick={() => setActiveTab(i)}
						type='button'
					>
						{section.translated || `Topic ${i + 1}`}
					</button>
				))}
			</div>
			{parsed[activeTab] && (
				<div>
					<div className='text-gray-900 text-lg leading-relaxed font-sans mb-6 whitespace-pre-line'>
						<div className={`font-bold mb-2 ${theme.text}`}>
							{parsed[activeTab].translated}
						</div>
						{parsed[activeTab].summary
							? parsed[activeTab].summary.split(/\n\nSources:/)[0]
							: null}
					</div>
					{(() => {
						const summary = parsed[activeTab].summary;
						if (!summary) return null;
						const parts = summary.split(/\n\nSources:/);
						if (parts.length < 2) return null;
						const sourcesBlock = parts[1];
						const links = sourcesBlock
							.split(/\n/)
							.map((line: string) => line.trim())
							.filter((line: string) => line.length > 0);
						if (!links.length) return null;
						return (
							<div className='mb-2 mt-6'>
								<div className='font-semibold text-blue-800 mb-1'>
									Sources:
								</div>
								<ul className='list-disc pl-6'>
									{links.map((url: string, idx: number) => (
										<li key={idx} className='mb-2'>
											<a
												href={url}
												target='_blank'
												rel='noopener noreferrer'
												className='text-blue-700 underline break-all'
											>
												{url}
											</a>
										</li>
									))}
								</ul>
							</div>
						);
					})()}
				</div>
			)}
		</div>
	);
}
