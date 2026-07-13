let previousBuild: Promise<void> = Promise.resolve();

export async function withBunBuildLock<T>(operation: () => Promise<T>): Promise<T> {
  const waitForPreviousBuild = previousBuild;
  let releaseBuild: (() => void) | undefined;
  previousBuild = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  await waitForPreviousBuild;
  try {
    return await operation();
  } finally {
    releaseBuild?.();
  }
}
