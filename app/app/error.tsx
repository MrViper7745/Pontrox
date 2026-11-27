"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="max-w-md text-sm text-gray-500">
        Your last design is saved in this browser. {error.message}
      </p>
      <div className="flex gap-2">
        <button onClick={reset} className="rounded bg-blue-600 px-3 py-2 text-white">
          Try again
        </button>
        <button
          onClick={() => {
            try {
              localStorage.removeItem("pontrox-session-v1");
            } catch {
              /* ignore */
            }
            location.reload();
          }}
          className="rounded border px-3 py-2"
        >
          Start fresh
        </button>
      </div>
    </main>
  );
}