export function createExecutionMutationSerializer() {
  let queue = Promise.resolve();
  return (operation) => {
    if (typeof operation !== "function") throw new Error("invalid-execution-mutation");
    const current = queue.catch(() => {}).then(operation);
    queue = current;
    return current;
  };
}
