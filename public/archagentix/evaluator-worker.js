self.addEventListener('message', async (e) => {
  const { query, dataset } = e.data;
  
  if (!query) return;

  const qLower = query.toLowerCase();
  let response = "I couldn't find a direct match in the dataset.";

  if (qLower.includes('cheapest') || qLower.includes('cost') || qLower.includes('price')) {
    const sortedByPrice = [...dataset].sort((a, b) => a.cost.prompt_per_1m - b.cost.prompt_per_1m);
    const cheapest = sortedByPrice[0];
    response = `The most cost-effective model in the benchmark dataset is **${cheapest.name}** at **$${cheapest.cost.prompt_per_1m}/1M prompt tokens** (SWE-bench: ${cheapest.benchmarks.swe_bench}%, Simple Score: ${cheapest.simple_score}).`;
  } else if (qLower.includes('swe') || qLower.includes('coding') || qLower.includes('highest')) {
    const sortedBySwe = [...dataset].sort((a, b) => b.benchmarks.swe_bench - a.benchmarks.swe_bench);
    const topSwe = sortedBySwe[0];
    response = `The top coding model by SWE-bench Verified score is **${topSwe.name}** with **${topSwe.benchmarks.swe_bench}%** (Rank #${topSwe.rank}, Prompt Price: $${topSwe.cost.prompt_per_1m}/1M).`;
  } else if (qLower.includes('rate limit') || qLower.includes('rpm') || qLower.includes('tpm')) {
    response = dataset.map(m => `• **${m.name}**: ${m.features.rate_limits.rpm} RPM, ${m.features.rate_limits.tpm.toLocaleString()} TPM`).join('\n');
  } else if (qLower.includes('cache') || qLower.includes('caching')) {
    const cachingModels = dataset.filter(m => m.features.prompt_cache_supported);
    response = `Models with Prompt Caching support:\n` + cachingModels.map(m => `• **${m.name}**: ${m.features.cache_discount_pct}% discount ($${m.cost.cached_input_per_1m}/1M cached prompt)`).join('\n');
  } else {
    response = `Found ${dataset.length} benchmarked models. Top model overall is **${dataset[0].name}** with a Simple Score of **${dataset[0].simple_score}**.`;
  }

  self.postMessage({ response });
});
