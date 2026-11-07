export function Onboarding({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="m-auto max-w-md text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-3xl">
        📦
      </div>
      <h2 className="text-base font-semibold text-slate-200">Create a project to get started</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-500">
        A project defines the working directory and provider for its agent
        sessions. Leave the working dir blank to use the server default.
      </p>
      <button
        onClick={onCreate}
        className="mt-5 rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
      >
        Create your first project
      </button>
    </div>
  );
}
