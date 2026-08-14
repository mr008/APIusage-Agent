import { webSearch, fetchPage } from "../src/tools.js";

const search = await webSearch("Yelp Fusion API documentation", 3);
console.log("--- search ---\n" + search.slice(0, 600));
const page = await fetchPage("https://docs.developer.yelp.com/docs/fusion-intro");
console.log("\n--- page (first 400 chars) ---\n" + page.slice(0, 400));
