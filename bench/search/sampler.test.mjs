import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCounterNameMaps,
  counterNamesUsed,
  localizeCounters,
  parseTypeperfCsv,
  TYPEPERF_COUNTERS,
} from "./sampler.mjs";

const english = [
  "1",
  "1847",
  "4",
  "Memory",
  "6",
  "% Processor Time",
  "230",
  "Process",
  "238",
  "Processor",
  "784",
  "ID Process",
  "1382",
  "Available MBytes",
];
const spanish = [
  "1",
  "1847",
  "4",
  "Memoria",
  "6",
  "% de tiempo de procesador",
  "230",
  "Proceso",
  "238",
  "Procesador",
  "784",
  "Id. de proceso",
  "1382",
  "Mbytes disponibles",
];

test("counter names are translated through Perflib indexes, unknown names stay English", () => {
  const toLocal = buildCounterNameMaps(english, spanish, counterNamesUsed());
  assert.equal(toLocal.Processor, "Procesador");
  assert.equal(toLocal["% Processor Time"], "% de tiempo de procesador");
  assert.equal(toLocal.PhysicalDisk, "PhysicalDisk");
  const localized = localizeCounters(TYPEPERF_COUNTERS, toLocal);
  assert.equal(localized[0], "\\Procesador(_Total)\\% de tiempo de procesador");
  assert.equal(localized.at(-1), "\\Memoria\\Mbytes disponibles");
});

test("localized typeperf CSV headers parse back to English counters", () => {
  const toLocal = buildCounterNameMaps(english, spanish, counterNamesUsed());
  const csv = [
    '"(PDH-CSV 4.0)","\\\\PC\\Procesador(_Total)\\% de tiempo de procesador","\\\\PC\\Proceso(node)\\Id. de proceso","\\\\PC\\Proceso(node)\\% de tiempo de procesador","\\\\PC\\Memoria\\Mbytes disponibles"',
    '"10/10/2026 14:02:14.490","25.5","42","80","12000"',
  ].join("\r\n");
  const { samples, unavailable } = parseTypeperfCsv(csv, { workerPid: 42, toLocal });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].cpuTotal, 25.5);
  assert.equal(samples[0].availableMB, 12000);
  assert.deepEqual(samples[0].worker, { cpu: 80, workingSet: undefined, handles: undefined });
  assert.ok(!unavailable.includes("cpu"));
});
