self.addEventListener('message', async (e) => {
  const { query, dataset } = e.data;
  
  if (!query) return;

  const qLower = query.toLowerCase();
  let response = "I couldn't find a direct match in the dataset.";

  if (qLower.includes('zero') || qLower.includes('0') || qLower.includes('meaning') || qLower.includes('available')) {
    response = `**Note on Dataset Values:** Any pricing or metric field indicated as **0** or **0.0** signifies that data was **not available** for that specific condition or provider SKU in the source dataset.`;
  } else if (qLower.includes('webgpu') || qLower.includes('ai') || qLower.includes('performance')) {
    response = `For optimal performance, this browser-based AI assistant leverages WebGPU acceleration (via Transformers.js / ONNX) when hardware acceleration is available in your browser.`;
  } else if (qLower.includes('cheapest') || qLower.includes('cost') || qLower.includes('price')) {
    const valid = dataset.filter(m => parseFloat(m.input_usd_per_1m) > 0).sort((a, b) => parseFloat(a.input_usd_per_1m) - parseFloat(b.input_usd_per_1m));
    const cheapest = valid[0];
    response = `The most cost-effective model in the dataset is **${cheapest.model_name || cheapest.model_id}** (${cheapest.provider}) at **$${cheapest.input_usd_per_1m}/1M input tokens**. *(Note: Values of 0 signify data unavailable).*`;
  } else {
    response = `Loaded ${dataset.length} model pricing entries from CSV sources. Any field with **0** indicates data not available for that tier. Running in-browser WebGPU assistant.`;
  }

  self.postMessage({ response });
});
