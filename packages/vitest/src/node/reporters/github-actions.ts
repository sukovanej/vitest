import { Writable } from 'node:stream'
import { getTasks } from '@vitest/runner/utils'
import stripAnsi from 'strip-ansi'
import type { File, Reporter, Vitest } from '../../types'
import { getFullName } from '../../utils'
import { printError } from '../error'
import { Logger } from '../logger'
import type { WorkspaceProject } from '../workspace'

export class GithubActionsReporter implements Reporter {
  ctx: Vitest = undefined!

  onInit(ctx: Vitest) {
    this.ctx = ctx
  }

  async onFinished(files: File[] = [], errors: unknown[] = []) {
    // collect all errors and associate them with projects
    const projectErrors = new Array<{ project: WorkspaceProject; title: string; error: unknown }>()
    for (const error of errors) {
      projectErrors.push({
        project: this.ctx.getCoreWorkspaceProject(),
        title: 'Unhandled error',
        error,
      })
    }
    for (const file of files) {
      const tasks = getTasks(file)
      const project = this.ctx.getProjectByTaskId(file.id)
      for (const task of tasks) {
        if (task.result?.state !== 'fail')
          continue

        const title = getFullName(task, ' > ')
        for (const error of task.result?.errors ?? []) {
          projectErrors.push({
            project,
            title,
            error,
          })
        }
      }
    }

    // format errors via `printError`
    for (const { project, title, error } of projectErrors) {
      const result = await printErrorWrapper(error, this.ctx, project)
      const stack = result?.nearest
      if (!stack)
        continue
      const formatted = formatMessage({
        command: 'error',
        properties: {
          file: stack.file,
          title,
          line: String(stack.line),
          column: String(stack.column),
        },
        message: stripAnsi(result.output),
      })
      this.ctx.logger.log(`\n${formatted}`)
    }
  }
}

// use Logger with custom Console to extract messgage from `processError` util
// TODO: maybe refactor `processError` to require single function `(message: string) => void` instead of full Logger?
async function printErrorWrapper(error: unknown, ctx: Vitest, project: WorkspaceProject) {
  let output = ''
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk)
      callback()
    },
  })
  const result = await printError(error, project, {
    showCodeFrame: false,
    logger: new Logger(ctx, writable, writable),
  })
  return { nearest: result?.nearest, output }
}

// workflow command formatting based on
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#setting-an-error-message
// https://github.com/actions/toolkit/blob/f1d9b4b985e6f0f728b4b766db73498403fd5ca3/packages/core/src/command.ts#L80-L85
function formatMessage({
  command,
  properties,
  message,
}: {
  command: string
  properties: Record<string, string>
  message: string
}): string {
  let result = `::${command}`
  Object.entries(properties).forEach(([k, v], i) => {
    result += i === 0 ? ' ' : ','
    result += `${k}=${escapeProperty(v)}`
  })
  result += `::${escapeData(message)}`
  return result
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C')
}
