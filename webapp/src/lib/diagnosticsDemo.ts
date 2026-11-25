// This fixture uses a separate local key and never imports the network logger.
const demoKey = "kiyometa-diagnostics-demo";
const processId = crypto.randomUUID();
const rows = [
  { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "web", operation: "demo.order.save", stage: "process.start", rc: "00", process_id: processId },
  { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "supabase", operation: "POST /rest/v1/orders", stage: "request.start", rc: "00", process_id: processId },
  { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "supabase", operation: "POST /rest/v1/orders", stage: "request.end", rc: "00", http_status: 201, process_id: processId },
  { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "ocr", operation: "POST /ocr/jobs", stage: "request.end", rc: "SVC-001", http_status: 503, process_id: processId },
];
try { localStorage.setItem(demoKey, JSON.stringify(rows)); } catch { /* The console sample still works if storage is unavailable. */ }
console.log("Demo process_id:", processId);
console.table(rows);
(window as Window & { clearKiyometaDiagnosticDemo?: () => void }).clearKiyometaDiagnosticDemo = () => {
  try { localStorage.removeItem(demoKey); } catch { /* Demo data is optional. */ }
};
