export async function benchmarkCommand() {
  const { benchmarkFlow } = await import("../benchmark.mjs");
  return await benchmarkFlow();
}
