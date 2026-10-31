self.addEventListener('message', async (e) => {
  const { query, dataset } = e.data;
  
  if (!query) return;

  const qLower = query.toLowerCase();
  let response = "I couldn't find a direct match in the dataset.";

  if (qLower.includes('cheapest') || qLower.includes('cost') || qLower.includes('price')) {
    response = `The most cost-effective open-source model for agentic development is **Qwen 2.5 Coder 32B** hosted on **Alibaba DashScope** at **$0.08/1M prompt tokens**.`;
  } else if (qLower.includes('swe') || qLower.includes('coding') || qLower.includes('highest')) {
    const sortedBySwe = [...dataset].sort((a, b) => b.benchmarks.swe_bench_verified - a.benchmarks.swe_bench_verified);
    const topSwe = sortedBySwe[0];
    response = `The top agentic coding model by SWE-bench Verified score is **${topSwe.name}** with **${topSwe.benchmarks.swe_bench_verified}%** (Context: ${topSwe.parameters.context_window_tokens.toLocaleString()} tokens).`;
  } else if (qLower.includes('cloud') || qLower.includes('bedrock') || qLower.includes('vertex') || qLower.includes('dashscope')) {
    response = dataset.map(m => `• **${m.name}**: Best Cost Cloud -> ${m.relations.best_cloud_provider_for_cost}`).join('\n');
  } else {
    response = `Found ${dataset.length} agentic coding models filtered across AWS Bedrock, GCP Vertex AI, Digital Ocean Gradient, and Alibaba DashScope. Top model overall is **${dataset[0].name}** with a Simple Score of **${dataset[0].simple_score}**.`;
  }

  self.postMessage({ response });
});
