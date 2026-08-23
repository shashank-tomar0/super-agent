import { useState } from "react";
import type { AgentTask } from "../../types";

interface TaskInputProps {
  onStartTask: (description: string, data?: Record<string, string>) => void;
  onCancelTask: () => void;
  task: AgentTask | null;
  pipelineResult?: any;
}

const QUICK_TASKS = [
  { label: "Fill this form", icon: "📝", prompt: "Fill the current form with my saved data" },
  { label: "Extract data", icon: "📊", prompt: "Extract all visible data from this page into structured format" },
  { label: "Navigate to...", icon: "🧭", prompt: "Navigate to the target URL" },
  { label: "Find & click", icon: "🔍", prompt: "Find and click the target element" },
];

export function TaskInput({ onStartTask, onCancelTask, task, pipelineResult: _pipelineResult }: TaskInputProps) {
  const [input, setInput] = useState("");
  const [showDataFields, setShowDataFields] = useState(false);
  const [dataFields, setDataFields] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    if (!input.trim()) return;
    onStartTask(input, Object.keys(dataFields).length > 0 ? dataFields : undefined);
    setInput("");
  };

  const handleQuickTask = (prompt: string) => {
    setInput(prompt);
  };

  const isRunning = task?.status === "executing" || task?.status === "analyzing" || task?.status === "planning" || task?.status === "verifying";

  return (
    <div className="flex flex-col h-full">
      {/* Active Task Display */}
      {task && isRunning && (
        <div className="mx-4 mt-4 p-3 bg-gray-900 rounded-lg border border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-300">
              {task.status === "analyzing" && "👁️ Analyzing page..."}
              {task.status === "planning" && "🧠 Planning actions..."}
              {task.status === "executing" && `⚡ Executing step ${task.currentStep + 1}/${task.totalSteps}`}
              {task.status === "verifying" && "✅ Verifying action..."}
              {task.status === "recovering" && "🔄 Recovering from error..."}
            </span>
            <button
              onClick={onCancelTask}
              className="text-[10px] text-red-400 hover:text-red-300 px-2 py-0.5 rounded bg-red-900/20"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mb-2">{task.description}</p>

          {/* Progress bar */}
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${task.totalSteps > 0 ? (task.currentStep / task.totalSteps) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-gray-500">
              {task.currentStep}/{task.totalSteps} steps
            </span>
            <span className="text-[10px] text-gray-500">
              {task.plan.estimatedTime > 0
                ? `~${Math.round(task.plan.estimatedTime / 1000)}s`
                : ""}
            </span>
          </div>
        </div>
      )}

      {/* Completed Task */}
      {task?.status === "completed" && (
        <div className="mx-4 mt-4 p-3 bg-green-900/20 rounded-lg border border-green-800/30">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-green-400">✅</span>
            <span className="text-xs font-medium text-green-300">Task Completed</span>
          </div>
          <p className="text-[11px] text-gray-400">{task.result}</p>
        </div>
      )}

      {/* Failed Task */}
      {task?.status === "failed" && (
        <div className="mx-4 mt-4 p-3 bg-red-900/20 rounded-lg border border-red-800/30">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-red-400">❌</span>
            <span className="text-xs font-medium text-red-300">Task Failed</span>
          </div>
          <p className="text-[11px] text-gray-400">{task.error || "Unknown error"}</p>
        </div>
      )}

      {/* Quick Tasks */}
      <div className="px-4 mt-4">
        <p className="text-[10px] text-gray-500 mb-2 uppercase tracking-wider">Quick Actions</p>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_TASKS.map((qt) => (
            <button
              key={qt.label}
              onClick={() => handleQuickTask(qt.prompt)}
              className="flex items-center gap-2 p-2 bg-gray-900 rounded-lg border border-gray-800 hover:border-gray-600 transition-colors text-left"
            >
              <span>{qt.icon}</span>
              <span className="text-[11px] text-gray-300">{qt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Data Fields (optional) */}
      {showDataFields && (
        <div className="mx-4 mb-2 p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-[10px] text-gray-500 mb-2">Additional Data</p>
          <div className="space-y-2">
            {Object.entries(dataFields).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <input
                  value={key}
                  readOnly
                  className="flex-1 text-[11px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                />
                <input
                  value={value}
                  readOnly
                  className="flex-1 text-[11px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                />
              </div>
            ))}
            <button
              onClick={() => {
                const key = prompt("Field name:");
                const value = prompt("Field value:");
                if (key && value) {
                  setDataFields((prev) => ({ ...prev, [key]: value }));
                }
              }}
              className="text-[10px] text-blue-400 hover:text-blue-300"
            >
              + Add field
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="p-4 border-t border-gray-800">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setShowDataFields(!showDataFields)}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${
              showDataFields
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            + Data
          </button>
        </div>
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Tell the agent what to do..."
            rows={2}
            className="flex-1 text-xs bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isRunning}
            className="self-end px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {isRunning ? "..." : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
