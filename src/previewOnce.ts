import { previewJourney } from './checker/journeyPreview.js';

const url = process.argv[2];
if (!url) throw new Error('Usage: npm run preview:once -- "<ebilet.intercity.pl URL>"');
console.log(JSON.stringify(await previewJourney(url), null, 2));
