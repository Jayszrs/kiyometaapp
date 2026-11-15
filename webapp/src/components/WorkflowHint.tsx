export default function WorkflowHint({ steps }: { steps: Array<{ number: string; title: string; detail: string }> }) {
  return <div className="grid gap-2 sm:grid-cols-3" aria-label="Workflow">
    {steps.map(step => <div key={step.number} className="flex gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#1a3458] text-xs font-700 text-white">{step.number}</span><div className="min-w-0"><p className="text-xs font-700 text-slate-800">{step.title}</p><p className="mt-0.5 text-xs leading-4 text-slate-600">{step.detail}</p></div></div>)}
  </div>;
}
