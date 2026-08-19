import { WINDOWS_ACL_RUNNER_ARG } from '@deepseek-ai/dsh-sandbox-windows-acl'

/**
 * Extract runner arguments from a fixed Web process invocation.
 *
 * Node source execution keeps the source entry at `argv[1]`; a SEA executable
 * may put the first user argument there instead. Searching after argv[0]
 * supports both forms while leaving ordinary Web startup arguments untouched.
 * @param argv - the complete process argv.
 * @returns arguments after the runner marker, or `undefined` for Web startup.
 */
export function runnerArgsFromWebBundleArgv(argv: readonly string[]): readonly string[] | undefined {
  const markerIndex = argv.indexOf(WINDOWS_ACL_RUNNER_ARG, 1)
  return markerIndex < 0 ? undefined : argv.slice(markerIndex + 1)
}
