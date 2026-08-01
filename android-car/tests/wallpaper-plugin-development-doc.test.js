'use strict';

/**
 * Mechanical lint for the executable shell snippets in
 * WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md.
 *
 * This test intentionally validates document structure only. It does not run
 * any documented Git, GitHub, Gradle, adb, or transaction command.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const documentPath = path.resolve(
  __dirname,
  '..',
  'docs',
  'WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md',
);
const progressPath = path.resolve(
  __dirname,
  '..',
  'docs',
  'WALLPAPER-PLUGIN-PROGRESS.zh-CN.md',
);
const source = fs.readFileSync(documentPath, 'utf8');
const progressSource = fs.readFileSync(progressPath, 'utf8');
const sourceLines = source.split(/\r?\n/);
const progressLines = progressSource.split(/\r?\n/);

function parseShellFences(lines) {
  const fences = [];
  const headingStack = [];
  let active = null;
  let leadText = '';

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const lineNumber = index + 1;

    if (!active) {
      const heading = text.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (heading) {
        const level = heading[1].length;
        headingStack[level - 1] = heading[2];
        headingStack.length = level;
      }

      const opening = text.match(/^\s*```\s*(bash|sh|shell)\s*$/i);
      if (opening) {
        active = {
          language: opening[1].toLowerCase(),
          openingLine: lineNumber,
          headingPath: headingStack.filter(Boolean).join(' > '),
          leadText,
          lines: [],
        };
      } else if (text.trim() !== '') {
        leadText = text.trim();
      }
      continue;
    }

    if (/^\s*```\s*$/.test(text)) {
      fences.push({
        ...active,
        closingLine: lineNumber,
        code: active.lines.map((line) => line.text).join('\n'),
      });
      active = null;
      continue;
    }

    active.lines.push({ text, lineNumber });
  }

  assert.equal(active, null, 'unclosed bash/sh/shell fence in development document');
  return fences;
}

function effectiveLines(fence) {
  return fence.lines.filter(({ text }) => {
    const trimmed = text.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

function heredocDelimiters(text) {
  const delimiters = [];
  let quote = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== '<' || text[index + 1] !== '<' || text[index + 2] === '<') continue;

    let cursor = index + 2;
    let stripTabs = false;
    if (text[cursor] === '-') {
      stripTabs = true;
      cursor += 1;
    }
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    let delimiter = '';
    const delimiterQuote = text[cursor] === "'" || text[cursor] === '"' ? text[cursor++] : null;
    while (cursor < text.length) {
      const next = text[cursor];
      if (delimiterQuote ? next === delimiterQuote : /[\s;&|()<>]/.test(next)) break;
      if (next === '\\' && !delimiterQuote && cursor + 1 < text.length) cursor += 1;
      delimiter += text[cursor];
      cursor += 1;
    }
    if (delimiterQuote && text[cursor] !== delimiterQuote) continue;
    if (delimiter) delimiters.push({ delimiter, stripTabs });
    index = cursor;
  }
  return delimiters;
}

function linesWithoutHeredocBodies(lines) {
  const executable = [];
  const pending = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.stripTabs ? line.text.replace(/^\t+/, '') : line.text;
      if (candidate === current.delimiter) pending.shift();
      continue;
    }
    executable.push(line);
    pending.push(...heredocDelimiters(line.text));
  }
  return executable;
}

function splitShellStatements(lines) {
  const commands = [];
  let buffer = '';
  let startLine = null;
  let quote = null;
  let escaped = false;
  let bracketDepth = 0;

  function append(text, lineNumber) {
    if (startLine === null && text.trim() !== '') startLine = lineNumber;
    buffer += text;
  }

  function flush() {
    const text = buffer.replace(/\\\s+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text !== '') commands.push({ lineNumber: startLine, text });
    buffer = '';
    startLine = null;
  }

  for (const line of lines) {
    const text = `${line.text}\n`;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (escaped) {
        if (char === '\n') append(' ', line.lineNumber);
        else append(`\\${char}`, line.lineNumber);
        escaped = false;
        continue;
      }
      if (quote === "'") {
        append(char, line.lineNumber);
        if (char === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        append(char, line.lineNumber);
        if (char === '\\') escaped = true;
        else if (char === '"') quote = null;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        append(char, line.lineNumber);
        continue;
      }
      if (char === '#' && (buffer.trim() === '' || /\s/.test(buffer.at(-1) ?? ''))) {
        while (index < text.length && text[index] !== '\n') index += 1;
        flush();
        continue;
      }
      if (char === '[' && next === '[') {
        bracketDepth += 1;
        append('[[', line.lineNumber);
        index += 1;
        continue;
      }
      if (char === ']' && next === ']' && bracketDepth > 0) {
        bracketDepth -= 1;
        append(']]', line.lineNumber);
        index += 1;
        continue;
      }
      const doubleOperator = (char === '&' && next === '&') || (char === '|' && next === '|');
      const separator = bracketDepth === 0 && (char === ';' || char === '|' || doubleOperator);
      if (separator) {
        flush();
        if (doubleOperator) index += 1;
        continue;
      }
      if (char === '\n') {
        flush();
        continue;
      }
      append(char, line.lineNumber);
    }
  }
  flush();
  return commands;
}

function matchingCommandSubstitution(text, openIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = openIndex + 2; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      else if (char === '$' && next === '(') {
        depth += 1;
        index += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) return index;
      }
      continue;
    }
    if (char === '\\') escaped = true;
    else if (char === "'" || char === '"') quote = char;
    else if (char === '$' && next === '(') {
      depth += 1;
      index += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function shellWords(text) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;

  function flush() {
    if (word !== '') words.push(word);
    word = '';
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') escaped = true;
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) flush();
    else word += char;
  }
  flush();
  return words;
}

function simpleInvocation(text) {
  const argv = shellWords(text);
  let index = 0;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(argv[index])) index += 1;
  while (['if', 'elif', 'while', 'until', '!', 'command', 'builtin', 'env'].includes(argv[index])) index += 1;
  if (index >= argv.length || ['then', 'do', 'done', 'else', 'fi', 'case', 'esac', '{', '}'].includes(argv[index])) return null;
  return {
    executable: argv[index],
    argv: argv.slice(index),
    text: text.replace(/\s+/g, ' ').trim(),
  };
}

function commandInvocations(command) {
  if (command.invocations) return command.invocations;
  const invocations = [];
  const topLevel = simpleInvocation(command.text);
  if (topLevel) invocations.push(topLevel);

  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.text.length - 1; index += 1) {
    const char = command.text[index];
    const next = command.text[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'") {
      quote = char;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char !== '$' || next !== '(') continue;

    const closing = matchingCommandSubstitution(command.text, index);
    if (closing < 0) break;
    const nestedText = command.text.slice(index + 2, closing);
    const nestedLines = [{ text: nestedText, lineNumber: command.lineNumber }];
    for (const nestedCommand of splitShellStatements(nestedLines)) {
      invocations.push(...commandInvocations(nestedCommand));
    }
    index = closing;
  }
  command.invocations = invocations;
  return invocations;
}

function logicalCommands(fence) {
  return splitShellStatements(linesWithoutHeredocBodies(fence.lines)).map((command) => ({
    ...command,
    invocations: commandInvocations(command),
  }));
}

function location(fence, lineNumber = fence.openingLine) {
  return `line ${lineNumber} (${fence.headingPath || 'no heading'})`;
}

function assertNoViolations(label, violations) {
  assert.equal(
    violations.length,
    0,
    `${label}:\n${violations.map((item) => `- ${item}`).join('\n')}`,
  );
}

function isPlanBootstrapFence(fence) {
  return fence.headingPath.includes('WP-PLAN-01');
}

function isInfraBootstrapFence(fence) {
  return fence.headingPath.includes('4.1.0 一次性事务框架 bootstrap');
}

function isPreTransactionPlanGateFence(fence) {
  return fence.headingPath.includes('4.6 计划 merge Gate 与实现分支 bootstrap');
}

function firstNonStrictCommand(fence) {
  return logicalCommands(fence).find(({ text }) => text !== 'set -euo pipefail') ?? null;
}

function startsWithAbsoluteCd(fence) {
  const first = firstNonStrictCommand(fence);
  return Boolean(first && /^cd(?:\s+--)?\s+(?:"\/|'\/|\/)/.test(first.text));
}

function isAbsoluteGitCOnlyFence(fence) {
  const commands = logicalCommands(fence).filter(({ text }) => text !== 'set -euo pipefail');
  return commands.length > 0 && commands.every(({ text }) => (
    /^git\s+-C\s+(?:"\/|'\/|\/)[^\s]*\s+/.test(text)
  ));
}

function executableName(invocation) {
  return invocation.executable.split('/').at(-1);
}

function transactionInvocations(command, subcommands = null) {
  const allowed = subcommands ? new Set(subcommands) : null;
  return commandInvocations(command).filter((invocation) => (
    executableName(invocation) === 'python3'
    && invocation.argv.length >= 3
    && (!allowed || allowed.has(invocation.argv[2]))
  ));
}

function isTransactionCommand(command, subcommands) {
  return transactionInvocations(command, subcommands).length > 0;
}

function isSyncCommand(command) {
  return isTransactionCommand(command, ['sync', 'sync-control']);
}

function isStateAssertion(command) {
  return isTransactionCommand(command, ['next', 'assert-state']);
}

function isPrMergeReadbackOrContainment(command) {
  return (
    /\bgh\s+pr\s+(?:create|edit|merge|view|list)\b/.test(command.text)
    || /\bgit(?:\s+-C\s+\S+)?\s+ls-remote\b/.test(command.text)
    || /\bgit(?:\s+-C\s+\S+)?\s+merge-base\s+--is-ancestor\b/.test(command.text)
    || isTransactionCommand(command, [
      'readback',
      'open-pr',
      'merge-pr',
      'pr-open-or-readback',
      'pr-final-readback',
      'pr-merged-readback',
      'base-containment',
      'verify-base-containment',
      'assert-base-contains',
      'assert-base-containment',
    ])
  );
}

function localAssignmentBefore(fence, variable, referenceLine) {
  const assignment = new RegExp(`^(?:export\\s+)?${variable}=`);
  return effectiveLines(fence).some(({ text, lineNumber }) => (
    lineNumber <= referenceLine && assignment.test(text.trim())
  ));
}

function isInsideShellFence(lineNumber) {
  return shellFences.some((fence) => (
    lineNumber >= fence.openingLine && lineNumber <= fence.closingLine
  ));
}

function sectionForTask(task) {
  const numbered = task.match(/^WP-0([0-9])$/);
  const headingLevel = numbered ? 3 : 4;
  const headingPattern = numbered
    ? new RegExp(`^###\\s+Task\\s+${numbered[1]}:`)
    : new RegExp(`^####\\s+${task}(?:（|\\s|[:：])`);
  const startIndex = sourceLines.findIndex((line, index) => (
    !isInsideShellFence(index + 1) && headingPattern.test(line)
  ));
  assert.notEqual(startIndex, -1, `missing ${task} section`);

  let endIndex = sourceLines.length;
  const boundary = new RegExp(`^#{1,${headingLevel}}\\s+`);
  for (let index = startIndex + 1; index < sourceLines.length; index += 1) {
    if (isInsideShellFence(index + 1)) continue;
    if (boundary.test(sourceLines[index])) {
      endIndex = index;
      break;
    }
  }

  return {
    task,
    startLine: startIndex + 1,
    endLine: endIndex,
    text: sourceLines.slice(startIndex, endIndex).join('\n'),
    fences: shellFences.filter((fence) => (
      fence.openingLine > startIndex + 1 && fence.openingLine <= endIndex
    )),
  };
}

function commandForTask(fence, task, subcommandName, extraPattern = null) {
  return logicalCommands(fence).some((command) => (
    subcommand(command, subcommandName, task, extraPattern)
  ));
}

function stateForTask(fence, task, state) {
  return logicalCommands(fence).some((command) => transactionInvocations(command, ['assert-state']).some((invocation) => (
    new RegExp(`--task\\s+${task}\\b`).test(invocation.text)
    && new RegExp(`(?:--expected|--one-of)\\s+[^\\n]*\\b${state}\\b`).test(invocation.text)
  )));
}

function findOrderedPipelineFences(section) {
  const { task, fences } = section;
  const stagePredicates = [
    (fence) => (
      commandForTask(fence, task, 'reconcile')
      && commandForTask(fence, task, 'prepare-leg', /--leg\s+plugin\b/)
    ),
    (fence) => (
      commandForTask(fence, task, 'commit-leg', /--leg\s+plugin\b/)
      && stateForTask(fence, task, 'PLUGIN_COMMITTED')
      && commandForTask(fence, task, 'open-attempt')
      && stateForTask(fence, task, 'EVIDENCE_ATTEMPT_OPEN')
      && fence.code.includes('collect-wp12-evidence.py')
      && commandForTask(fence, task, 'record-raw')
      && stateForTask(fence, task, 'RAW_COLLECTED')
      && fence.code.includes('seal-wp12-evidence.py')
      && stateForTask(fence, task, 'EVIDENCE_SEALED')
      && commandForTask(fence, task, 'prepare-leg', /--leg\s+evidence\b/)
    ),
    (fence) => (
      commandForTask(fence, task, 'commit-leg', /--leg\s+evidence\b/)
      && commandForTask(fence, task, 'sync', /--repo\s+plugin\b[^\n]*--leg\s+plugin\b/)
      && stateForTask(fence, task, 'PLUGIN_PUSHED')
      && commandForTask(fence, task, 'sync', /--repo\s+mineradio\b[^\n]*--leg\s+evidence\b/)
      && stateForTask(fence, task, 'MINERADIO_EVIDENCE_PUSHED')
      && commandForTask(fence, task, 'prepare-leg', /--leg\s+closure\b/)
    ),
    (fence) => (
      commandForTask(fence, task, 'commit-leg', /--leg\s+closure\b/)
      && commandForTask(fence, task, 'sync', /--repo\s+mineradio\b[^\n]*--leg\s+closure\b/)
      && stateForTask(fence, task, 'MINERADIO_CLOSURE_PUSHED')
      && commandForTask(fence, task, 'verify-done')
      && stateForTask(fence, task, 'DONE')
    ),
  ];

  const matches = [];
  let minimumOpeningLine = section.startLine;
  for (const predicate of stagePredicates) {
    const match = fences.find((fence) => (
      fence.openingLine > minimumOpeningLine && predicate(fence)
    ));
    if (!match) return null;
    matches.push(match);
    minimumOpeningLine = match.openingLine;
  }
  return matches;
}

function hasCompleteFailedAttempt(section) {
  const ordered = section.fences.flatMap((fence) => (
    logicalCommands(fence).map((command) => ({
      ...command,
      fenceOpeningLine: fence.openingLine,
    }))
  ));
  const taskPattern = new RegExp(`--task\\s+${section.task}\\b`);
  const failIndex = ordered.findIndex((command) => (
    /\bfail-attempt\b/.test(command.text) && taskPattern.test(command.text)
  ));
  if (failIndex < 0) return false;

  const failedStateIndex = ordered.findIndex((command, index) => (
    index > failIndex
    && /\bassert-state\b/.test(command.text)
    && taskPattern.test(command.text)
    && /\bATTEMPT_FAILED\b/.test(command.text)
  ));
  const reopenIndex = ordered.findIndex((command, index) => (
    index > failedStateIndex
    && /\bopen-attempt\b/.test(command.text)
    && taskPattern.test(command.text)
  ));
  const reopenedStateIndex = ordered.findIndex((command, index) => (
    index > reopenIndex
    && /\bassert-state\b/.test(command.text)
    && taskPattern.test(command.text)
    && /\bEVIDENCE_ATTEMPT_OPEN\b/.test(command.text)
  ));

  return failIndex < failedStateIndex
    && failedStateIndex < reopenIndex
    && reopenIndex < reopenedStateIndex
    && ordered[reopenIndex].fenceOpeningLine > ordered[failIndex].fenceOpeningLine;
}

function verifyDoneImmediatelyAssertsDone(section) {
  return section.fences.some((fence) => {
    const commands = logicalCommands(fence);
    return commands.some((command, index) => (
      commandForTask(
        { ...fence, lines: [{ text: command.text, lineNumber: command.lineNumber }] },
        section.task,
        'verify-done',
      )
      && index + 1 < commands.length
      && /\bassert-state\b/.test(commands[index + 1].text)
      && new RegExp(`--task\\s+${section.task}\\b`).test(commands[index + 1].text)
      && /\bDONE\b/.test(commands[index + 1].text)
    ));
  });
}


function sectionByHeading(lines, headingPattern, level, label) {
  const usesDevelopmentSource = lines === sourceLines;
  const startIndex = lines.findIndex((line, index) => (
    (!usesDevelopmentSource || !isInsideShellFence(index + 1)) && headingPattern.test(line)
  ));
  assert.notEqual(startIndex, -1, `missing ${label} section`);

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (usesDevelopmentSource && isInsideShellFence(index + 1)) continue;
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= level) {
      endIndex = index;
      break;
    }
  }

  return {
    startLine: startIndex + 1,
    endLine: endIndex,
    text: lines.slice(startIndex, endIndex).join('\n'),
  };
}

function developmentSection(headingPattern, level, label) {
  const section = sectionByHeading(sourceLines, headingPattern, level, label);
  return {
    ...section,
    fences: shellFences.filter((fence) => (
      fence.openingLine > section.startLine && fence.openingLine <= section.endLine
    )),
  };
}

function taskNineSection() {
  return developmentSection(/^###\s+Task 9:/, 3, 'Task 9 / WP-09');
}

function taskElevenCSection() {
  return developmentSection(/^####\s+WP-11C(?:（|\s|:)/, 4, 'WP-11C');
}

function wp12Section(task) {
  return developmentSection(new RegExp(`^####\\s+${task}(?:（|\\s|:)`), 4, task);
}

function transactionCommands(fence, task = null) {
  return logicalCommands(fence).filter((command) => transactionInvocations(command).some((invocation) => (
    !task || new RegExp(`--task\\s+${task}\\b`).test(invocation.text)
  )));
}

function orderedIndexes(commands, predicates) {
  const indexes = [];
  let cursor = 0;
  for (const predicate of predicates) {
    const offset = commands.slice(cursor).findIndex(predicate);
    if (offset < 0) return null;
    const index = cursor + offset;
    indexes.push(index);
    cursor = index + 1;
  }
  return indexes;
}

function exactState(command, task, state) {
  return transactionInvocations(command, ['assert-state']).some((invocation) => (
    new RegExp(`--task\\s+${task}\\b`).test(invocation.text)
    && new RegExp(`(?:--expected|--one-of)\\s+${state}(?:\\s|$)`).test(invocation.text)
  ));
}

function subcommand(command, name, task = null, extra = null) {
  return transactionInvocations(command, [name]).some((invocation) => {
    if (task && !new RegExp(`--task\\s+${task}\\b`).test(invocation.text)) return false;
    return !extra || extra.test(invocation.text);
  });
}

function commandCount(commands, predicate) {
  return commands.filter(predicate).length;
}

function markdownRows(text) {
  return text.split(/\r?\n/)
    .filter((line) => /^\|\s*[^-]/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function weightMapFromProgress(text, ids) {
  const wanted = new Set(ids);
  const result = new Map();
  for (const row of markdownRows(text)) {
    if (!wanted.has(row[0])) continue;
    const match = row[2]?.match(/^(\d+)%$/);
    assert.ok(match, `missing numeric weight for ${row[0]} in progress table`);
    result.set(row[0], Number(match[1]));
  }
  return result;
}

function weightsFromDevelopmentTable(text, ids) {
  const wanted = new Set(ids);
  const result = new Map();
  for (const row of markdownRows(text)) {
    if (!wanted.has(row[0])) continue;
    const match = row[1]?.match(/^(\d+)%$/);
    if (!match) continue;
    result.set(row[0], Number(match[1]));
  }
  return result;
}

function hasRequiredDeviceContext(command, task) {
  return subcommand(command, 'assert-device-context', task)
    && /--serial\s+"\$SERIAL"(?=\s|$)/.test(command.text)
    && /--android-release\s+12\b/.test(command.text)
    && /--api-level\s+31\b/.test(command.text)
    && /--abi\s+arm64-v8a\b/.test(command.text)
    && /--user\s+"\$TARGET_USER"(?=\s|$)/.test(command.text)
    && /--current-user\s+12\b/.test(command.text);
}

function touchesDevice(fence) {
  return /\badb(?:\s|$)/m.test(fence.code)
    || /collect-wallpaper-plugin-evidence\.sh/.test(fence.code)
    || /\bcollect-device-evidence\b/.test(fence.code)
    || /\bassert-device-context\b/.test(fence.code);
}

function immediatePair(commands, firstPredicate, secondPredicate) {
  return commands.some((command, index) => (
    firstPredicate(command) && index + 1 < commands.length && secondPredicate(commands[index + 1])
  ));
}

function createDocumentModel(documentSource) {
  const lines = documentSource.split(/\r?\n/);
  const fences = parseShellFences(lines);

  function insideFence(lineNumber) {
    return fences.some((fence) => lineNumber >= fence.openingLine && lineNumber <= fence.closingLine);
  }

  function section(headingPattern, level, label) {
    const startIndex = lines.findIndex((line, index) => (
      !insideFence(index + 1) && headingPattern.test(line)
    ));
    assert.notEqual(startIndex, -1, `missing ${label} section`);

    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (insideFence(index + 1)) continue;
      const heading = lines[index].match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= level) {
        endIndex = index;
        break;
      }
    }

    return {
      startLine: startIndex + 1,
      endLine: endIndex,
      text: lines.slice(startIndex, endIndex).join('\n'),
      fences: fences.filter((fence) => (
        fence.openingLine > startIndex + 1 && fence.openingLine <= endIndex
      )),
    };
  }

  function taskSection(task) {
    const numbered = task.match(/^WP-0([0-9])$/);
    const level = numbered ? 3 : 4;
    const headingPattern = numbered
      ? new RegExp(`^###\\s+Task\\s+${numbered[1]}:`)
      : new RegExp(`^####\\s+${task}(?:（|\\s|[:：])`);
    return { task, ...section(headingPattern, level, task) };
  }

  return {
    source: documentSource,
    lines,
    fences,
    section,
    taskSection,
  };
}

function replaceFirstOccurrence(text, before, after) {
  const index = text.indexOf(before);
  assert.notEqual(index, -1, `mutation fixture missing ${JSON.stringify(before)}`);
  return `${text.slice(0, index)}${after}${text.slice(index + before.length)}`;
}

const infraAllowlist = [
  'android-car/scripts/wallpaper-task.py',
  'android-car/scripts/wp09-transaction.py',
  'android-car/scripts/wp11c-transaction.py',
  'android-car/scripts/wp12-bootstrap.py',
  'android-car/scripts/generate-wallpaper-task-catalog.py',
  'android-car/scripts/wallpaper-task.schema.json',
  'android-car/scripts/wallpaper-plugin-tasks.json',
  'android-car/tests/wallpaper-task.test.js',
  'android-car/tests/wp09-transaction.test.js',
  'android-car/tests/wp11c-transaction.test.js',
  'android-car/tests/wp12-bootstrap.test.js',
  'android-car/tests/wallpaper-task-catalog.test.js',
];

function invocationMatches(invocation, executable, argvPrefix) {
  return executableName(invocation) === executable
    && argvPrefix.every((value, index) => invocation.argv[index + 1] === value);
}

function commandsWithInvocation(fence, predicate) {
  return logicalCommands(fence).filter((command) => commandInvocations(command).some(predicate));
}

function validateCorePhaseLedger(document) {
  const violations = [];
  const executableRecordPhase = document.fences.flatMap(logicalCommands)
    .filter((command) => subcommand(command, 'record-phase'));
  if (executableRecordPhase.length !== 0) {
    violations.push(`caller-controlled record-phase remains executable ${executableRecordPhase.length} time(s)`);
  }

  const protocol = document.section(/^####\s+4\.1\.1\s+/, 4, 'single phase protocol');
  const phaseFence = protocol.fences.find((fence) => (
    logicalCommands(fence).some((command) => subcommand(command, 'begin-phase'))
  ));
  if (!phaseFence) {
    violations.push('missing catalog-bound single-phase fence');
  } else {
    const commands = logicalCommands(phaseFence);
    const stageNames = ['begin-phase', 'run-phase', 'complete-phase', 'assert-phase'];
    for (const name of stageNames) {
      const count = transactionInvocationsIn(commands, [name]).length;
      if (count !== 1) violations.push(`single-phase fence has ${count} ${name} commands`);
    }
    const stageInvocations = transactionInvocationsIn(commands, stageNames);
    if (stageInvocations.some(({ invocation }) => invocation.argv[2] === 'begin-phase' && !/--from-catalog(?:\s|$)/.test(invocation.text))) {
      violations.push('begin-phase is not catalog-bound');
    }
    if (stageInvocations.some(({ invocation }) => invocation.argv[2] === 'run-phase' && !/--from-catalog(?:\s|$)/.test(invocation.text))) {
      violations.push('run-phase is not catalog-bound');
    }
    if (stageInvocations.some(({ invocation }) => invocation.argv[2] === 'complete-phase' && !/--from-receipt(?:\s|$)/.test(invocation.text))) {
      violations.push('complete-phase does not consume receipt');
    }
    const phaseLiterals = stageInvocations.flatMap(({ invocation }) => (
      invocation.text.match(/--phase\s+(RED|GREEN|REFACTOR|VERIFY)\b/g) ?? []
    ));
    if (phaseLiterals.length > 1) violations.push('single-phase fence embeds multiple phase literals');
  }

  for (const token of [
    'dependsOn', 'requiredEffectiveDone', 'phaseCommands', 'expectedExit',
    'failureSignaturePolicy', 'scopeCheck', 'stable topological', 'reject unknown dependency',
    'reject dependency cycle', 'actualExitCode', 'stdoutSha256', 'stderrSha256',
    'catalogCommandSha256', 'preScopeSha256', 'postScopeSha256', 'previousPhaseReceiptSha256', 'dependencyReceiptSha256',
  ]) {
    if (!protocol.text.includes(token)) violations.push(`phase/catalog contract missing ${token}`);
  }
  if (!/WP-00 RED[^\n]*真实非零/.test(protocol.text)) violations.push('WP-00 RED is not required to produce a real non-zero exit');
  for (const forbidden of ['else RED_RC=1', '`true`', '调用者硬编码结果']) {
    if (!protocol.text.includes(forbidden)) violations.push(`WP-00 RED anti-forgery rule missing ${forbidden}`);
  }
  const verifiedPhase = document.fences.flatMap(logicalCommands).some((command) => (
    transactionInvocations(command).some((invocation) => /--phase\s+VERIFIED\b/.test(invocation.text))
  ));
  if (verifiedPhase) violations.push('VERIFIED is used as a phase instead of a derived state');
  return violations;
}

function transactionInvocationsIn(commands, names) {
  return commands.flatMap((command) => transactionInvocations(command, names).map((invocation) => ({ command, invocation })));
}

function validateInfraBootstrapIntegrity(document) {
  const violations = [];
  const section = document.section(/^####\s+4\.1\.0\s+/, 4, 'WP-INFRA');
  const prepare = section.fences.find((fence) => commandsWithInvocation(fence, (invocation) => (
    invocationMatches(invocation, 'git', ['add', '--'])
  )).length > 0);
  if (!prepare) {
    violations.push('missing WP-INFRA prepare fence');
    return violations;
  }

  const addedPaths = commandsWithInvocation(prepare, (invocation) => (
    invocationMatches(invocation, 'git', ['add', '--'])
  )).flatMap((command) => commandInvocations(command)
    .filter((invocation) => invocationMatches(invocation, 'git', ['add', '--']))
    .map((invocation) => invocation.argv.slice(3))
  ).flat();
  if (addedPaths.length !== infraAllowlist.length
      || addedPaths.some((value, index) => value !== infraAllowlist[index])) {
    violations.push(`WP-INFRA git add allowlist mismatch: ${JSON.stringify(addedPaths)}`);
  }
  if (commandsWithInvocation(prepare, (invocation) => (
    executableName(invocation) === 'git'
    && invocation.argv[1] === 'add'
    && invocation.argv.slice(2).some((value) => ['.', '-A', '--all'].includes(value))
  )).length > 0) violations.push('WP-INFRA uses broad git add');
  for (const [pattern, message] of [
    [/APPROVED_PARENT_SHA="\$\(git rev-parse HEAD\)"/, 'missing approved parent readback'],
    [/CURRENT_REF="\$\(git symbolic-ref -q HEAD\)"/, 'missing symbolic ref readback'],
    [/git read-tree "\$APPROVED_PARENT_SHA"/, 'missing read-tree of approved parent'],
  ]) if (!pattern.test(prepare.code)) violations.push(message);

  const commit = section.fences.find((fence) => commandsWithInvocation(fence, (invocation) => (
    invocationMatches(invocation, 'git', ['commit-tree'])
  )).length > 0);
  if (!commit) {
    violations.push('missing WP-INFRA commit fence');
  } else {
    const updateRefs = commandsWithInvocation(commit, (invocation) => (
      invocationMatches(invocation, 'git', ['update-ref'])
    ));
    const exactCas = updateRefs.some((command) => commandInvocations(command).some((invocation) => (
      executableName(invocation) === 'git'
      && invocation.argv.length === 5
      && invocation.argv[1] === 'update-ref'
      && invocation.argv[2] === '$CURRENT_REF'
      && invocation.argv[3] === '$INFRA_SHA'
      && invocation.argv[4] === '$APPROVED_PARENT_SHA'
    )));
    if (!exactCas) violations.push('WP-INFRA update-ref is missing exact old-SHA CAS');
    if (commandsWithInvocation(commit, (invocation) => invocationMatches(invocation, 'git', ['reset'])).length > 0) {
      violations.push('WP-INFRA commit fence uses git reset');
    }
  }
  return violations;
}

function validateEvidenceManifestReadback(document) {
  const violations = [];
  for (const task of ['WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C']) {
    const section = document.taskSection(task);
    const fence = section.fences.find((item) => logicalCommands(item).some((command) => subcommand(command, 'seal-evidence', task)));
    if (!fence) {
      violations.push(`${task} missing final seal fence`);
      continue;
    }
    const indexes = orderedIndexes(logicalCommands(fence), [
      (command) => subcommand(command, 'seal-evidence', task),
      (command) => subcommand(command, 'evidence-manifest-sha') && /--file\s+"\$TXN_FILE"/.test(command.text) && /--single-line/.test(command.text),
      (command) => /\[\[ "\$MANIFEST_SHA" =~ \^\[0-9a-f\]\{64\}\$ \]\]/.test(command.text),
      (command) => subcommand(command, 'record-manifest-readback') && /--file\s+"\$TXN_FILE"/.test(command.text) && /--sha256\s+"\$MANIFEST_SHA"/.test(command.text),
      (command) => subcommand(command, 'prepare-progress', task),
    ]);
    if (!indexes) violations.push(`${task} does not seal -> readback 64hex -> persist manifest SHA before progress`);
  }
  return violations;
}

function validatePlanCommit2CountGuards(document) {
  const section = document.section(/^###\s+4\.5\s+/, 3, 'plan baseline workflow');
  const required = [
    [/for old, new in replacements:\s*\n\s*old_count = (?:s|source)\.count\(old\)[\s\S]*?if old_count != 1:/, 'missing preimage old_count != 1 guard'],
    [/for old, new in replacements:\s*\n\s*old_count = (?:s|source)\.count\(old\)[\s\S]*?if new_count != 0:/, 'missing preimage new_count != 0 guard'],
    [/for old, new in replacements:\s*\n\s*old_count = candidate\.count\(old\)[\s\S]*?if old_count != 0:/, 'missing postimage old_count != 0 guard'],
    [/for old, new in replacements:\s*\n\s*old_count = candidate\.count\(old\)[\s\S]*?if new_count != 1:/, 'missing postimage new_count != 1 guard'],
  ];
  return required.filter(([pattern]) => !pattern.test(section.text)).map(([, message]) => message);
}

const shellFences = parseShellFences(sourceLines);
const developmentDocument = createDocumentModel(source);

test('development document contains closed bash/sh/shell fences', () => {
  assert.ok(shellFences.length > 0, `no shell fences found in ${documentPath}`);
});

test('every shell fence starts with strict mode', () => {
  const violations = shellFences.flatMap((fence) => {
    const first = effectiveLines(fence)[0];
    if (first && first.text.trim() === 'set -euo pipefail') return [];
    return [
      `${location(fence)} first effective command is ${JSON.stringify(first?.text.trim() ?? '<empty>')}`,
    ];
  });
  assertNoViolations('shell fences must start with set -euo pipefail', violations);
});

test('every shell fence fixes cwd with an absolute cd or is absolute git -C only', () => {
  const violations = shellFences.flatMap((fence) => {
    if (startsWithAbsoluteCd(fence) || isAbsoluteGitCOnlyFence(fence)) return [];
    return [`${location(fence)} first non-strict command is not an absolute cd and the fence is not absolute git -C only`];
  });
  assertNoViolations('cwd-dependent shell fences', violations);
});

test('protected commit SHA variables are never inherited across fences', () => {
  const protectedReference = /\$(?:\{)?(PLAN_SHA|BASELINE_SHA|WP\d{2}[A-Z]?(?:_[A-Z0-9]+)*_PARENT_SHA)(?:\})?/g;
  const violations = [];

  for (const fence of shellFences) {
    for (const line of fence.lines) {
      for (const match of line.text.matchAll(protectedReference)) {
        const variable = match[1];
        if (!localAssignmentBefore(fence, variable, line.lineNumber)) {
          violations.push(
            `${location(fence, line.lineNumber)} references ${variable} without a same-fence prior assignment`,
          );
        }
      }
    }
  }

  assertNoViolations('cross-fence SHA variables', violations);
});

test('every transaction sync is immediately followed by next or assert-state in the same fence', () => {
  const violations = [];
  for (const fence of shellFences) {
    const commands = logicalCommands(fence);
    commands.forEach((command, index) => {
      if (!isSyncCommand(command)) return;
      const next = commands[index + 1];
      if (!next || !isStateAssertion(next)) {
        violations.push(
          `${location(fence, command.lineNumber)} sync is followed by ${JSON.stringify(next?.text ?? '<end of fence>')}`,
        );
      }
    });
  }
  assertNoViolations('sync state checks', violations);
});

test('transactional PR, merge, readback, and containment operations assert state immediately', () => {
  const violations = [];
  for (const fence of shellFences) {
    if (isPlanBootstrapFence(fence) || isPreTransactionPlanGateFence(fence) || isInfraBootstrapFence(fence)) continue;
    const commands = logicalCommands(fence);
    commands.forEach((command, index) => {
      if (!isTransactionCommand(command, [
        'readback', 'open-pr', 'merge-pr', 'pr-open-or-readback',
        'pr-final-readback', 'pr-merged-readback', 'base-containment',
        'verify-base-containment', 'assert-base-contains', 'assert-base-containment',
      ])) return;
      const next = commands[index + 1];
      if (!next || !/\bassert-state\b/.test(next.text)) {
        violations.push(
          `${location(fence, command.lineNumber)} operation ${JSON.stringify(command.text)} is not immediately followed by assert-state`,
        );
      }
    });
  }
  assertNoViolations('unasserted transactional PR/merge/readback/base-containment operations', violations);
});

test('SCRIPT_DIR and WORK_DIR are defined before shell-fence use', () => {
  const violations = [];
  for (const fence of shellFences) {
    for (const variable of ['SCRIPT_DIR', 'WORK_DIR']) {
      const reference = new RegExp(`\\$(?:\\{)?${variable}(?:\\})?`);
      for (const line of fence.lines) {
        if (!reference.test(line.text)) continue;
        if (!localAssignmentBefore(fence, variable, line.lineNumber)) {
          violations.push(
            `${location(fence, line.lineNumber)} references ${variable} without a same-fence prior assignment`,
          );
        }
      }
    }
  }
  assertNoViolations('undefined shell working variables', violations);
});

test('direct push and manual PR mutation exist only in the bounded plan and WP-INFRA bootstrap exceptions', () => {
  const pushes = [];
  const prMutations = [];
  const forcePushes = [];

  for (const fence of shellFences) {
    for (const command of logicalCommands(fence)) {
      if (/\bgit\s+push\b/.test(command.text)) pushes.push({ fence, command });
      if (/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b)/.test(command.text)) {
        forcePushes.push({ fence, command });
      }
      if (/\bgh\s+pr\s+(?:create|edit|merge)\b/.test(command.text)) {
        prMutations.push({ fence, command });
      }
    }
  }

  const violations = [];
  for (const { fence, command } of forcePushes) {
    violations.push(`${location(fence, command.lineNumber)} force push is forbidden`);
  }
  for (const { fence, command } of pushes) {
    const exactPlanPush = isPlanBootstrapFence(fence)
      && /\bgit\s+push\s+--set-upstream\s+origin\s+"\$BASELINE_SHA:refs\/heads\/(?:\$BRANCH|codex\/wallpaper-plugin-development-plan)"\s*$/.test(command.text);
    const exactInfraPush = isInfraBootstrapFence(fence)
      && /\bgit\s+push\s+origin\s+"\$INFRA_SHA:refs\/heads\/codex\/wallpaper-plugin-control"\s*$/.test(command.text);
    if (!exactPlanPush && !exactInfraPush) {
      violations.push(`${location(fence, command.lineNumber)} direct push is outside the exact bounded bootstrap exceptions`);
    }
  }
  for (const { fence, command } of prMutations) {
    const allowedPlanMutation = (isPlanBootstrapFence(fence) || isPreTransactionPlanGateFence(fence))
      && /\bgh\s+pr\s+(?:create|merge)\b/.test(command.text);
    if (!allowedPlanMutation) {
      violations.push(`${location(fence, command.lineNumber)} manual gh pr mutation is forbidden`);
    }
  }

  if (pushes.length !== 2) {
    violations.push(`expected exactly two direct exact-SHA bootstrap pushes (plan and WP-INFRA), found ${pushes.length}`);
  }
  const planCreates = prMutations.filter(({ fence, command }) => (
    isPlanBootstrapFence(fence) && /\bgh\s+pr\s+create\b/.test(command.text)
  ));
  const planMerges = prMutations.filter(({ fence, command }) => (
    isPreTransactionPlanGateFence(fence) && /\bgh\s+pr\s+merge\b/.test(command.text)
  ));
  if (planCreates.length !== 1) violations.push(`expected exactly one WP-PLAN-01 gh pr create, found ${planCreates.length}`);
  if (planMerges.length !== 1) violations.push(`expected exactly one WP-PLAN-01 gh pr merge, found ${planMerges.length}`);

  assertNoViolations('forbidden direct Git/GitHub mutations', violations);
});

test('transaction commands use canonical hyphenated task IDs', () => {
  const violations = [];
  for (const fence of shellFences) {
    for (const command of logicalCommands(fence)) {
      const matches = command.text.matchAll(/--task\s+(WP(?:0[0-9]|1[0-2][A-E]?))\b/g);
      for (const match of matches) {
        violations.push(`${location(fence, command.lineNumber)} uses non-canonical task ID ${match[1]}`);
      }
    }
  }
  assertNoViolations('non-canonical task IDs', violations);
});

test('WP-12A through WP-12E each spell out four COMMIT fences and recovery closure', () => {
  const violations = [];

  for (const task of ['WP-12A', 'WP-12B', 'WP-12C', 'WP-12D', 'WP-12E']) {
    const section = sectionForTask(task);

    if (!/\bCOMMIT\b/.test(section.text)) {
      violations.push(`${task} has no explicit COMMIT section`);
    }
    if (task !== 'WP-12A' && /(?:与|使用|严格使用).*WP-12A.*(?:相同|管线|替换)/.test(section.text)) {
      violations.push(`${task} delegates its COMMIT pipeline to WP-12A instead of spelling it out`);
    }

    const pipeline = findOrderedPipelineFences(section);
    if (!pipeline || new Set(pipeline.map((fence) => fence.openingLine)).size !== 4) {
      violations.push(
        `${task} does not contain four ordered, distinct COMMIT fences for plugin prepare; plugin/evidence collection; evidence sync/closure prepare; closure sync/DONE`,
      );
    }
    if (!hasCompleteFailedAttempt(section)) {
      violations.push(
        `${task} lacks fail-attempt -> ATTEMPT_FAILED assert -> open-attempt -> EVIDENCE_ATTEMPT_OPEN assert`,
      );
    }
    if (!verifyDoneImmediatelyAssertsDone(section)) {
      violations.push(`${task} lacks verify-done immediately followed by assert-state DONE`);
    }
  }

  assertNoViolations('incomplete WP-12 mechanical task loops', violations);
});

test('WP-INFRA is a fail-closed unweighted gate with progress, DoR, and next-loop routing', () => {
  const violations = [];
  const taskZero = developmentSection(/^###\s+Task 0:/, 3, 'Task 0');

  if (!/^###\s+WP-INFRA\b/m.test(progressSource)) {
    violations.push('progress document has no dedicated WP-INFRA cycle record');
  }
  if (!/WP-INFRA[\s\S]{0,500}(?:不计权|权重：\s*0%)/.test(progressSource)) {
    violations.push('WP-INFRA is not explicitly recorded as an unweighted gate');
  }
  if (!/下一循环：\s*WP-INFRA\b/.test(progressSource)) {
    violations.push('WP-PLAN-01 does not route the next loop to WP-INFRA');
  }
  if (/WP-PLAN-02\b/.test(progressSource) || /WP-PLAN-02\b/.test(source)) {
    violations.push('undefined WP-PLAN-02 is still referenced');
  }

  const dor = taskZero.text.match(/\*\*DoR:\*\*([^\n]+)/)?.[1] ?? '';
  for (const [label, pattern] of [
    ['WP-INFRA=DONE', /WP-INFRA\s*=\s*DONE|WP-INFRA[^\n]*`DONE`/],
    ['runner SHA', /runnerSha|runner SHA/i],
    ['catalog tests', /wallpaper-task-catalog\.test\.js|catalog tests?/i],
    ['schema tests', /wallpaper-task\.schema\.json|schema tests?/i],
    ['exact origin readback', /exact origin readback|ls-remote/i],
  ]) {
    if (!pattern.test(dor)) violations.push(`Task 0 DoR does not require ${label}`);
  }

  assertNoViolations('WP-INFRA gate contract', violations);
});

test('plan is fail-closed before WP-00 until plan commit, merged readback, and WP-INFRA DONE', () => {
  const taskZeroLine = sourceLines.findIndex((line) => /^###\s+Task 0:/.test(line));
  assert.notEqual(taskZeroLine, -1, 'missing Task 0 heading');
  const preTaskZero = sourceLines.slice(0, taskZeroLine).join('\n');
  const violations = [];

  if (!/fail-closed|失败关闭|闭锁/.test(preTaskZero)) {
    violations.push('pre-WP-00 plan has no explicit fail-closed declaration');
  }
  if (!/PLAN_COMMITTED/.test(preTaskZero)) {
    violations.push('pre-WP-00 gate does not require PLAN_COMMITTED');
  }
  if (!/(?:计划|plan)\s*PR[^\n]{0,160}(?:merged\/readback|合并[^\n]{0,40}回读)/i.test(preTaskZero)) {
    violations.push('pre-WP-00 gate does not require plan PR merged/readback');
  }
  if (!/WP-INFRA\s*=\s*DONE|WP-INFRA[^\n]{0,80}`DONE`/.test(preTaskZero)) {
    violations.push('pre-WP-00 gate does not require WP-INFRA DONE');
  }
  if (!/不得[^\n]{0,80}(?:执行|启动|开始)[^\n]{0,40}WP-00/.test(preTaskZero)) {
    violations.push('pre-WP-00 gate does not explicitly forbid starting WP-00 when any gate is missing');
  }

  assertNoViolations('plan fail-closed entry gate', violations);
});

test('WP-09 selects exactly one official APK source and closes Plugin PR through merge readback', () => {
  const section = taskNineSection();
  const commands = section.fences.flatMap(logicalCommands);
  const violations = [];

  if (/\$\{WE_OFFICIAL_APK:\?/.test(section.text) || /\$\{WE_OFFICIAL_APKS_FILE:\?/.test(section.text)) {
    violations.push('official APK and split-list are both unconditionally required');
  }
  const exactOne = section.fences.some((fence) => {
    const byPhysicalLine = new Map();
    for (const command of logicalCommands(fence)) {
      const existing = byPhysicalLine.get(command.lineNumber) ?? '';
      byPhysicalLine.set(command.lineNumber, `${existing} ${command.text}`.trim());
    }
    return [...byPhysicalLine.values()].some((text) => (
      /WE_OFFICIAL_APK/.test(text)
      && /WE_OFFICIAL_APKS_FILE/.test(text)
      && /(?:-eq\s+1|==\s*1|exact-one)/.test(text)
    ));
  });
  if (!exactOne) violations.push('no executable exact-one check chooses single APK XOR split-list');

  const mergeFence = section.fences.find((fence) => logicalCommands(fence).some((command) => (
    subcommand(command, 'merge-pr', null, /--kind\s+plugin\b/)
  )));
  if (!mergeFence) {
    violations.push('WP-09 has no transaction-controlled merge-pr --kind plugin');
  } else {
    const indexes = orderedIndexes(logicalCommands(mergeFence), [
      (command) => subcommand(command, 'merge-pr', null, /--kind\s+plugin\b/),
      (command) => /\bassert-state\b/.test(command.text) && /PLUGIN_PR_MERGE_IN_FLIGHT/.test(command.text),
      (command) => subcommand(command, 'pr-merged-readback', null, /--kind\s+plugin\b/),
      (command) => /\bassert-state\b/.test(command.text) && /PLUGIN_PR_MERGED_VERIFIED/.test(command.text),
    ]);
    if (!indexes) violations.push('Plugin merge does not persist IN_FLIGHT before merged readback and verified state');
  }

  if (commands.some((command) => /\bmark-done\b/.test(command.text))) {
    violations.push('WP-09 still uses mark-done instead of verify-done as the only DONE transition');
  }
  if (!section.fences.some((fence) => immediatePair(
    logicalCommands(fence),
    (command) => /\bverify-done\b/.test(command.text),
    (command) => /\bassert-state\b/.test(command.text) && /--expected\s+DONE\b/.test(command.text),
  ))) violations.push('WP-09 verify-done is not immediately followed by assert-state --expected DONE');

  assertNoViolations('WP-09 exact-one and PR closure', violations);
});

test('WP-10A through WP-11C each define a complete evidence attempt and crash-resume chain', () => {
  const violations = [];
  const tasks = ['WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C'];

  for (const task of tasks) {
    const section = developmentSection(new RegExp(`^####\\s+${task}(?:（|\\s|:)`), 4, task);
    const attemptFences = section.fences.filter((fence) => commandForTask(fence, task, 'open-attempt'));
    const resumeFences = section.fences.filter((fence) => commandForTask(fence, task, 'resume-attempt'));

    if (attemptFences.length !== 1) {
      violations.push(`${task} must contain exactly one primary open-attempt fence; found ${attemptFences.length}`);
    } else {
      const commands = logicalCommands(attemptFences[0]);
      const indexes = orderedIndexes(commands, [
        (command) => subcommand(command, 'open-attempt', task),
        (command) => exactState(command, task, 'EVIDENCE_ATTEMPT_OPEN'),
        (command) => subcommand(command, 'record-raw', task),
        (command) => exactState(command, task, 'RAW_COLLECTED'),
        (command) => subcommand(command, 'seal-raw', task),
        (command) => exactState(command, task, 'RAW_SEALED'),
      ]);
      if (!indexes) {
        violations.push(`${task} primary attempt does not spell open -> OPEN -> record-raw -> RAW -> seal-raw -> RAW_SEALED in one fence`);
      }
    }

    if (resumeFences.length !== 1) {
      violations.push(`${task} must contain exactly one crash resume-attempt fence; found ${resumeFences.length}`);
    } else {
      const commands = logicalCommands(resumeFences[0]);
      const indexes = orderedIndexes(commands, [
        (command) => subcommand(command, 'reconcile', task),
        (command) => subcommand(command, 'resume-attempt', task)
          && /--recover-open-as\s+ATTEMPT_FAILED\b/.test(command.text)
          && /--recover-raw-as\s+ATTEMPT_FAILED\b/.test(command.text)
          && /--continue-raw-sealed\b/.test(command.text),
        (command) => /\bassert-state\b/.test(command.text)
          && new RegExp(`--task\\s+${task}\\b`).test(command.text)
          && /--one-of\s+ATTEMPT_FAILED,RAW_SEALED\b/.test(command.text),
      ]);
      if (!indexes) {
        violations.push(`${task} resume fence does not route OPEN/RAW to ATTEMPT_FAILED and RAW_SEALED to continuation`);
      }
    }

    const finalSeals = section.fences.flatMap(logicalCommands).filter((command) => subcommand(command, 'seal-evidence', task));
    if (finalSeals.length !== 1) {
      violations.push(`${task} must seal final evidence exactly once after implementation commit; found ${finalSeals.length}`);
    }

    if (!section.fences.some((fence) => immediatePair(
      logicalCommands(fence),
      (command) => subcommand(command, 'verify-done', task),
      (command) => exactState(command, task, 'DONE'),
    ))) {
      violations.push(`${task} verify-done is not immediately followed by assert-state --expected DONE`);
    }
  }

  assertNoViolations('device evidence attempt/resume contracts', violations);
});

test('every WP-10/WP-11 adb fence requires explicit canonical device context without defaults', () => {
  const violations = [];
  const tasks = ['WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C'];

  for (const task of tasks) {
    const section = developmentSection(new RegExp(`^####\\s+${task}(?:（|\\s|:)`), 4, task);
    const adbFences = section.fences.filter(touchesDevice);
    if (adbFences.length === 0) {
      violations.push(`${task} has no device-touching fence to bind to canonical device context`);
      continue;
    }

    for (const fence of adbFences) {
      if (/\$\{SERIAL:-/.test(fence.code) || /\$\{TARGET_USER:-/.test(fence.code)) {
        violations.push(`${location(fence)} defaults SERIAL or TARGET_USER instead of requiring explicit values`);
      }
      if (!/:\s*"\$\{SERIAL:\?/.test(fence.code) || !/:\s*"\$\{TARGET_USER:\?/.test(fence.code)) {
        violations.push(`${location(fence)} does not fail closed on explicit SERIAL and TARGET_USER`);
      }
      const commands = logicalCommands(fence);
      const firstAdb = commands.findIndex(({ text }) => /\badb(?:\s|$)/.test(text) || /collect-wallpaper-plugin-evidence\.sh/.test(text) || /\bcollect-device-evidence\b/.test(text) || /\bassert-device-context\b/.test(text));
      const context = commands.findIndex((command) => hasRequiredDeviceContext(command, task));
      if (context < 0 || context > firstAdb) {
        violations.push(`${location(fence)} lacks pre-device assert-device-context for Android 12/API 31/arm64/user 12/current user`);
      }
    }
  }

  assertNoViolations('canonical device context', violations);
});

test('WP-11C reads authoritative DONE only from origin/huawei-android12-car', () => {
  const section = taskElevenCSection();
  const violations = [];
  const canonicalTxn = '/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin/transactions/wp-11c.json';

  for (const fence of section.fences.filter((item) => /wp11c-transaction\.py/.test(item.code))) {
    if (!new RegExp(`TXN_FILE=${canonicalTxn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(fence.code)) {
      violations.push(`${location(fence)} does not bind canonical wp-11c.json`);
    }
  }

  const readbackFence = section.fences.find((fence) => logicalCommands(fence).some((command) => (
    /\bread-authoritative-progress\b/.test(command.text)
  )));
  if (!readbackFence) {
    violations.push('WP-11C has no read-authoritative-progress command');
  } else {
    const commands = logicalCommands(readbackFence);
    const indexes = orderedIndexes(commands, [
      (command) => /\bread-authoritative-progress\b/.test(command.text)
        && /--base-ref\s+refs\/remotes\/origin\/huawei-android12-car\b/.test(command.text)
        && /--expected-status\s+DONE\b/.test(command.text)
        && /--expected-effective-done\s+false\b/.test(command.text)
        && /--expected-proposed-done\s+true\b/.test(command.text),
      (command) => /\bassert-state\b/.test(command.text)
        && /AUTHORITATIVE_PROGRESS_PROPOSED_DONE_VERIFIED/.test(command.text),
      (command) => /\bverify-done\b/.test(command.text),
      (command) => /\bassert-state\b/.test(command.text) && /--expected\s+DONE\b/.test(command.text),
    ]);
    if (!indexes) {
      violations.push('WP-11C authoritative proposed-DONE readback is not followed by transaction verify-done and derived DONE');
    }
  }

  assertNoViolations('WP-11C authoritative base closure', violations);
});

test('WP-12A through WP-12E have exactly four numbered COMMIT fences with exact state skeletons', () => {
  const violations = [];
  const tasks = ['WP-12A', 'WP-12B', 'WP-12C', 'WP-12D', 'WP-12E'];

  for (const task of tasks) {
    const section = wp12Section(task);
    const commitFences = section.fences.filter((fence) => /\*\*COMMIT fence\s+[1-4]\b/.test(fence.leadText));
    const numbers = commitFences.map((fence) => Number(fence.leadText.match(/COMMIT fence\s+([1-4])\b/)?.[1]));
    if (commitFences.length !== 4 || numbers.join(',') !== '1,2,3,4') {
      violations.push(`${task} COMMIT fences must be exactly four and numbered 1,2,3,4; found ${numbers.join(',') || 'none'}`);
      continue;
    }

    const skeletons = [
      [
        (command) => subcommand(command, 'reconcile', task),
        (command) => exactState(command, task, 'VERIFIED'),
        (command) => subcommand(command, 'prepare-leg', task, /--leg\s+plugin\b/),
        (command) => exactState(command, task, 'PLUGIN_PREPARED'),
      ],
      [
        (command) => subcommand(command, 'commit-leg', task, /--leg\s+plugin\b/),
        (command) => subcommand(command, 'reconcile', task),
        (command) => exactState(command, task, 'PLUGIN_COMMITTED'),
        (command) => subcommand(command, 'open-attempt', task),
        (command) => exactState(command, task, 'EVIDENCE_ATTEMPT_OPEN'),
        (command) => subcommand(command, 'record-raw', task),
        (command) => exactState(command, task, 'RAW_COLLECTED'),
        (command) => exactState(command, task, 'EVIDENCE_SEALED'),
        (command) => subcommand(command, 'prepare-leg', task, /--leg\s+evidence\b/),
        (command) => exactState(command, task, 'EVIDENCE_PREPARED'),
      ],
      [
        (command) => subcommand(command, 'commit-leg', task, /--leg\s+evidence\b/),
        (command) => subcommand(command, 'reconcile', task),
        (command) => exactState(command, task, 'MINERADIO_EVIDENCE_COMMITTED'),
        (command) => subcommand(command, 'sync', task, /--repo\s+plugin\b[^\n]*--leg\s+plugin\b/),
        (command) => exactState(command, task, 'PLUGIN_PUSHED'),
        (command) => subcommand(command, 'sync', task, /--repo\s+mineradio\b[^\n]*--leg\s+evidence\b/),
        (command) => exactState(command, task, 'MINERADIO_EVIDENCE_PUSHED'),
        (command) => subcommand(command, 'prepare-leg', task, /--leg\s+closure\b/),
        (command) => exactState(command, task, 'CLOSURE_PREPARED'),
      ],
      [
        (command) => subcommand(command, 'commit-leg', task, /--leg\s+closure\b/),
        (command) => subcommand(command, 'reconcile', task),
        (command) => exactState(command, task, 'MINERADIO_CLOSURE_COMMITTED'),
        (command) => subcommand(command, 'sync', task, /--repo\s+mineradio\b[^\n]*--leg\s+closure\b/),
        (command) => exactState(command, task, 'MINERADIO_CLOSURE_PUSHED'),
        (command) => subcommand(command, 'verify-done', task),
        (command) => exactState(command, task, 'DONE'),
      ],
    ];

    commitFences.forEach((fence, index) => {
      const commands = logicalCommands(fence);
      if (!orderedIndexes(commands, skeletons[index])) {
        violations.push(`${task} COMMIT fence ${index + 1} does not match the required ordered state skeleton`);
      }
    });

    const successCounts = new Map([
      ['prepare plugin', (command) => subcommand(command, 'prepare-leg', task, /--leg\s+plugin\b/)],
      ['commit plugin', (command) => subcommand(command, 'commit-leg', task, /--leg\s+plugin\b/)],
      ['open attempt', (command) => subcommand(command, 'open-attempt', task)],
      ['record raw', (command) => subcommand(command, 'record-raw', task)],
      ['prepare evidence', (command) => subcommand(command, 'prepare-leg', task, /--leg\s+evidence\b/)],
      ['commit evidence', (command) => subcommand(command, 'commit-leg', task, /--leg\s+evidence\b/)],
      ['prepare closure', (command) => subcommand(command, 'prepare-leg', task, /--leg\s+closure\b/)],
      ['commit closure', (command) => subcommand(command, 'commit-leg', task, /--leg\s+closure\b/)],
      ['verify done', (command) => subcommand(command, 'verify-done', task)],
    ]);
    const allCommitCommands = commitFences.flatMap(logicalCommands);
    for (const [label, predicate] of successCounts) {
      const count = commandCount(allCommitCommands, predicate);
      if (count !== 1) violations.push(`${task} has ${count} ${label} commands across COMMIT fences; expected exactly 1`);
    }
  }

  assertNoViolations('WP-12 exact COMMIT state machines', violations);
});

test('WP-12 crash recovery has a single resume router for every stable interruption state', () => {
  const violations = [];
  const protocol = developmentSection(/^####\s+WP-12 持久 transaction 与证据协议/, 4, 'WP-12 transaction protocol');
  const requiredRoutes = [
    ['EVIDENCE_ATTEMPT_OPEN', 'ATTEMPT_FAILED'],
    ['RAW_COLLECTED', 'ATTEMPT_FAILED'],
    ['ATTEMPT_FAILED', 'EVIDENCE_ATTEMPT_OPEN'],
    ['EVIDENCE_SEALED', 'EVIDENCE_PREPARED'],
    ['PLUGIN_COMMITTED', 'EVIDENCE_ATTEMPT_OPEN'],
    ['MINERADIO_EVIDENCE_COMMITTED', 'PLUGIN_PUSHED'],
    ['PLUGIN_PUSHED', 'MINERADIO_EVIDENCE_PUSHED'],
    ['MINERADIO_EVIDENCE_PUSHED', 'CLOSURE_PREPARED'],
    ['CLOSURE_PREPARED', 'MINERADIO_CLOSURE_COMMITTED'],
    ['MINERADIO_CLOSURE_COMMITTED', 'MINERADIO_CLOSURE_PUSHED'],
    ['MINERADIO_CLOSURE_PUSHED', 'DONE'],
  ];

  if (!/\bresume\b/.test(protocol.text)) {
    violations.push('WP-12 protocol does not define a resume router');
  }
  for (const [from, to] of requiredRoutes) {
    const route = new RegExp(`${from}[^\\n]{0,160}(?:→|->|=>)[^\\n]{0,160}${to}`);
    if (!route.test(protocol.text)) violations.push(`WP-12 resume route ${from} -> ${to} is missing`);
  }
  if (!/(?:禁止|不得)[^\n]{0,80}重复[^\n]{0,40}(?:commit|sync)/i.test(protocol.text)) {
    violations.push('WP-12 resume protocol does not forbid duplicate commit/sync after readback');
  }

  for (const task of ['WP-12A', 'WP-12B', 'WP-12C', 'WP-12D', 'WP-12E']) {
    const section = wp12Section(task);
    const resumeFences = section.fences.filter((fence) => commandForTask(fence, task, 'resume'));
    if (resumeFences.length !== 1) {
      violations.push(`${task} must have exactly one executable resume fence; found ${resumeFences.length}`);
      continue;
    }
    const commands = logicalCommands(resumeFences[0]);
    if (!orderedIndexes(commands, [
      (command) => subcommand(command, 'reconcile', task),
      (command) => subcommand(command, 'resume', task),
      (command) => /\bassert-state\b/.test(command.text) && new RegExp(`--task\\s+${task}\\b`).test(command.text),
    ])) {
      violations.push(`${task} resume fence must execute reconcile -> resume -> assert-state`);
    }
  }

  assertNoViolations('WP-12 crash resume routing', violations);
});

test('WP-12C RED and GREEN are separate catalog commands with a persisted implementation boundary', () => {
  const section = wp12Section('WP-12C');
  const violations = [];
  const required = [
    'WP-12C.RED.adapter-negative',
    'WP-12C.GREEN.adapter-positive',
    '--case adapter-negative',
    '--case adapter-positive',
    '*EmbeddedEngineAdapterNegativeTest',
    '*EmbeddedEngineAdapterTest',
    'scopeCheck',
    'NO_CHANGE',
  ];
  for (const token of required) {
    if (!section.text.includes(token)) violations.push(`WP-12C catalog contract missing ${token}`);
  }
  if (!/RED receipt durable write[\s\S]{0,300}退出当前 shell[\s\S]{0,500}RED 与 GREEN 两个 phase attempt 之间/.test(section.text)) {
    violations.push('WP-12C does not document a durable implementation boundary between RED and GREEN');
  }
  if (!/GREEN、REFACTOR、VERIFY[\s\S]{0,200}新的独立 shell/.test(section.text)) {
    violations.push('WP-12C post-RED stages are not separately resumable');
  }
  if (/\brecord-phase\b/.test(section.fences.flatMap(logicalCommands).map(({ text }) => text).join('\n'))) {
    violations.push('WP-12C still uses caller-declared record-phase commands');
  }

  assertNoViolations('WP-12C staged RED/GREEN', violations);
});

test('WP-12E uses one Scene+Video collector and one raw index in primary and resume paths', () => {
  const section = wp12Section('WP-12E');
  const collectorFences = section.fences.filter((fence) => /collect-wp12-evidence\.py/.test(fence.code));
  const violations = [];

  if (collectorFences.length !== 2) {
    violations.push(`WP-12E must have exactly two collector fences (primary and resume); found ${collectorFences.length}`);
  }
  for (const fence of collectorFences) {
    const commands = logicalCommands(fence);
    const collectors = commands.filter(({ text }) => /(?:^|\b(?:if|then)\s+)python3\s+"\$COLLECTOR"(?=\s|;|$)/.test(text));
    const records = commands.filter((command) => subcommand(command, 'record-raw', 'WP-12E'));
    if (collectors.length !== 1) violations.push(`${location(fence)} has ${collectors.length} collectors; expected 1`);
    if (records.length !== 1) violations.push(`${location(fence)} has ${records.length} record-raw commands; expected 1`);
    const collector = collectors[0]?.text ?? '';
    if (!/--sample-kind\s+scene,video\b/.test(collector)
      || !/--scene\s+"\$SCENE_MPKG"(?:\s|;|$)/.test(collector)
      || !/--video\s+"\$VIDEO_MPKG"(?:\s|;|$)/.test(collector)) {
      violations.push(`${location(fence)} collector is not a single scene,video invocation with both inputs`);
    }
  }

  assertNoViolations('WP-12E single collector contract', violations);
});

test('Mermaid expands WP-12A through WP-12E and keeps the experiment non-blocking', () => {
  const flow = developmentSection(/^##\s+8\. 执行顺序与并行调度/, 2, 'execution Mermaid');
  const violations = [];

  for (const task of ['T12A', 'T12B', 'T12C', 'T12D', 'T12E']) {
    if (!new RegExp(`\\b${task}\\[`).test(flow.text)) violations.push(`Mermaid is missing ${task}`);
  }
  if (!/T11B\s*-->\s*T12A\s*-->\s*T12B\s*-->\s*T12C\s*-->\s*T12D\s*-->\s*T12E/.test(flow.text)) {
    violations.push('Mermaid does not expand the ordered experimental chain T11B -> T12A -> T12B -> T12C -> T12D -> T12E');
  }
  if (!/T11B\s*-->\s*T11C/.test(flow.text)) {
    violations.push('Mermaid no longer preserves the independent core T11B -> T11C edge');
  }
  if (/T12E\s*-->\s*T11C|T12[A-E]\s*-->\s*T11C/.test(flow.text)) {
    violations.push('Mermaid incorrectly makes WP-12 an upstream gate for core WP-11C');
  }

  assertNoViolations('expanded non-blocking WP-12 Mermaid', violations);
});

test('core and experimental progress weights are complete and consistent with the development plan', () => {
  const coreIds = [
    'WP-00', 'WP-01', 'WP-02', 'WP-03', 'WP-04', 'WP-05', 'WP-06', 'WP-07', 'WP-08', 'WP-09',
    'WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C',
  ];
  const experimentalIds = ['WP-12A', 'WP-12B', 'WP-12C', 'WP-12D', 'WP-12E'];
  const core = weightMapFromProgress(progressSource, coreIds);
  const experimental = weightMapFromProgress(progressSource, experimentalIds);
  const developmentExperimental = weightsFromDevelopmentTable(source, experimentalIds);
  const violations = [];

  if (core.size !== coreIds.length) violations.push(`core progress table has ${core.size}/${coreIds.length} weighted tasks`);
  if ([...core.values()].reduce((sum, value) => sum + value, 0) !== 100) {
    violations.push('core progress weights do not total 100%');
  }
  if (experimental.size !== experimentalIds.length) {
    violations.push(`experimental progress table has ${experimental.size}/${experimentalIds.length} weighted tasks`);
  }
  if ([...experimental.values()].reduce((sum, value) => sum + value, 0) !== 100) {
    violations.push('experimental progress weights do not total 100%');
  }
  if (developmentExperimental.size !== experimentalIds.length) {
    violations.push(`development WP-12 table has ${developmentExperimental.size}/${experimentalIds.length} weighted tasks`);
  }
  for (const id of experimentalIds) {
    if (experimental.get(id) !== developmentExperimental.get(id)) {
      violations.push(`${id} weight differs: progress=${experimental.get(id)} development=${developmentExperimental.get(id)}`);
    }
    const heading = source.match(new RegExp(`^####\\s+${id}（(\\d+)%）`, 'm'));
    if (!heading || Number(heading[1]) !== experimental.get(id)) {
      violations.push(`${id} heading weight does not match progress table`);
    }
  }

  assertNoViolations('weight consistency', violations);
});

test('core phases are catalog-bound single-stage receipts and never caller-declared', () => {
  assertNoViolations('catalog-bound phase ledger', validateCorePhaseLedger(developmentDocument));
});
test('WP-INFRA defines executable bootstrap receipt commit sync merge and readback', () => {
  const section = developmentSection(/^####\s+4\.1\.0\s+/, 4, 'WP-INFRA');
  const required = [
    'WP-INFRA.json', 'exclusive-create', '0600', 'revision CAS', 'GIT_INDEX_FILE', 'git read-tree HEAD',
    'git add --', 'git write-tree', 'APPROVED_INDEX_TREE',
    'build(android-car): bootstrap wallpaper transaction runner',
    'runnerSha256', 'catalogSha256', 'schemaSha256',
    'git push origin "$INFRA_SHA:refs/heads/codex/wallpaper-plugin-control"',
    'git ls-remote --refs origin refs/heads/codex/wallpaper-plugin-control',
    'infra PR', 'merged/readback', 'authoritative base', 'EffectiveDone=true',
    'RED', 'GREEN', 'REFACTOR', 'VERIFY',
  ];
  const violations = required.filter((token) => !section.text.includes(token)).map((token) => `missing ${token}`);
  assertNoViolations('WP-INFRA bootstrap contract', violations);
});

test('WP-INFRA bootstrap freezes exact allowlist parent tree ref and exact remote readback', () => {
  assertNoViolations('WP-INFRA exact bootstrap integrity', validateInfraBootstrapIntegrity(developmentDocument));
});
test('device evidence paths are transaction-file addressed contained and never inherited', () => {
  const violations = [];
  const tasks = ['WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C'];
  for (const task of tasks) {
    const section = sectionForTask(task);
    for (const fence of section.fences.filter((item) => /\bEVIDENCE_DIR\b/.test(item.code))) {
      if (/:\s*"\$\{EVIDENCE_DIR:\?/.test(fence.code)) violations.push(`${location(fence)} inherits EVIDENCE_DIR from caller`);
      if (!new RegExp(`transaction-file[\\s\\S]*--task\\s+${task}\\b[\\s\\S]*--single-line`).test(fence.code)) {
        violations.push(`${location(fence)} does not resolve canonical transaction file for ${task}`);
      }
      if (!/evidence-path[\s\S]*--file\s+"\$TXN_FILE"[\s\S]*--single-line/.test(fence.code)) {
        violations.push(`${location(fence)} does not resolve evidence path from TXN_FILE`);
      }
      if (!/assert-evidence-path[\s\S]*--file\s+"\$TXN_FILE"[\s\S]*--path\s+"\$EVIDENCE_DIR"[\s\S]*--contained/.test(fence.code)) {
        violations.push(`${location(fence)} lacks evidence-path containment`);
      }
      if (/evidence-path\s+--task\b/.test(fence.code)) violations.push(`${location(fence)} uses task-addressed evidence-path`);
    }
  }
  assertNoViolations('transaction-owned evidence paths', violations);
});

test('device evidence resume fences writer before failing an open attempt', () => {
  const violations = [];
  for (const task of ['WP-10A', 'WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C']) {
    const section = sectionForTask(task);
    const fence = section.fences.find((item) => commandForTask(item, task, 'resume-attempt'));
    if (!fence) { violations.push(`${task} missing resume-attempt fence`); continue; }
    const indexes = orderedIndexes(logicalCommands(fence), [
      (command) => subcommand(command, 'reconcile', task),
      (command) => subcommand(command, 'fence-writer', task),
      (command) => /\bassert-state\b/.test(command.text) && /WRITER_FENCED/.test(command.text),
      (command) => subcommand(command, 'resume-attempt', task),
    ]);
    if (!indexes) violations.push(`${task} resumes without reconcile -> fence-writer -> WRITER_FENCED`);
  }
  assertNoViolations('writer-fenced crash recovery', violations);
});

test('WP-10A through WP-11C seal final evidence then read back manifest SHA', () => {
  assertNoViolations('final evidence manifest readback', validateEvidenceManifestReadback(developmentDocument));
});
test('E4 through E7 tasks consume the previous transaction manifest hash chain', () => {
  const violations = [];
  for (const task of ['WP-10B', 'WP-10C', 'WP-11A', 'WP-11B', 'WP-11C']) {
    const section = sectionForTask(task);
    for (const token of ['parentTaskId', 'parentTransactionId', 'parentRunUuid', 'parentManifestSha256', 'requiredEffectiveDone']) {
      if (!section.text.includes(token)) violations.push(`${task} missing ${token}`);
    }
    if (!/parent-evidence[\s\S]*--from-dependency-transaction/.test(section.text)) {
      violations.push(`${task} does not derive parent evidence from dependency transaction`);
    }
  }
  assertNoViolations('cross-task evidence hash chain', violations);
});

test('plan baseline transition is exact atomic and PR recovery covers all lifecycle states', () => {
  const baseline = developmentSection(/^###\s+4\.5\s+/, 3, 'plan baseline workflow');
  const merge = developmentSection(/^###\s+4\.6\s+/, 3, 'plan merge gate');
  const violations = [];
  for (const token of [
    'wallpaper-plan-transaction/v1', 'WP-PLAN-01.json', 'revision CAS', 'exclusive-create',
    'old_count != 1', 'new_count != 0', 'old_count != 0', 'new_count != 1',
    'PLAN_READY_FOR_COMMIT', 'PLAN_COMMITTED', 'WP-PLAN-01 COMMIT', 'WP-PLAN-01 PR Gate',
    'PLAN_PUSH_IN_FLIGHT', 'PLAN_PR_CREATE_IN_FLIGHT', 'state=all', '0 / 1 / >1',
  ]) if (!baseline.text.includes(token)) violations.push(`plan baseline missing ${token}`);
  for (const token of [
    'PLAN_PR_MERGE_IN_FLIGHT', 'OPEN', 'CLOSED_UNMERGED', 'MERGED', 'merged=true',
    'merge_commit_sha', 'merged_at', 'PLAN_BASE_CONTAINS_MERGE_VERIFIED', 'EffectiveDone=true',
  ]) if (!merge.text.includes(token)) violations.push(`plan merge gate missing ${token}`);
  violations.push(...validatePlanCommit2CountGuards(developmentDocument));
  assertNoViolations('plan commit and PR lifecycle', violations);
});

test('skip-implementation is WP-00-only idempotent VERIFIED-to-checkpoint transition', () => {
  const executable = shellFences.flatMap((fence) => logicalCommands(fence).map((command) => ({ fence, command })))
    .filter(({ command }) => /\bskip-implementation\b/.test(command.text));
  const violations = [];
  if (executable.length !== 1 || !/--task\s+WP-00\b/.test(executable[0]?.command.text ?? '')) {
    violations.push(`expected one WP-00 skip-implementation command; found ${executable.length}`);
  }
  const protocol = source.slice(source.indexOf('skip-implementation'));
  for (const token of ['IMPLEMENTATION_SKIPPED', 'allowSkipImplementation=true', 'idempotent', 'staged', 'unstaged', 'untracked', 'PREPARE_CHECKPOINT']) {
    if (!protocol.includes(token)) violations.push(`missing skip contract token ${token}`);
  }
  assertNoViolations('skip implementation contract', violations);
});

test('plan PR body is deterministically generated frozen and no-clobber', () => {
  const planSection = developmentSection(/^###\s+4\.5\s+/, 3, 'plan baseline workflow');
  const createFence = planSection.fences.find((fence) => /\bgh\s+pr\s+create\b/.test(fence.code));
  assert.ok(createFence, 'missing executable plan gh pr create fence');
  const beforeUse = sourceLines.slice(0, createFence.openingLine - 1).join('\n');
  const required = [
    'wallpaper-plan-pr/v1', 'Plan-Run-UUID', 'PLAN_SHA', 'BASELINE_SHA',
    'exclusive-create', 'no-clobber', '0600', 'plan-pr-body.md',
    'BLOCKED_PR_BODY_DRIFT', 'commit blob',
  ];
  const violations = required.filter((token) => !beforeUse.includes(token)).map((token) => `missing ${token} before gh pr create`);
  assertNoViolations('plan PR body contract', violations);
});

test('plan merge gate binds exactly one PR to baseline SHA repo ref body and origin readback', () => {
  const section = developmentSection(/^###\s+4\.6\s+/, 3, 'plan merge gate');
  const violations = [];
  if (/\]\[0\]|\]\[0\]\./.test(section.text) || /\]\[0\]/.test(section.text)) violations.push('selects first matching PR');
  for (const token of [
    'MATCHING_PR_COUNT', '-eq 1', '.head.sha', '.head.ref', '.head.repo.full_name',
    '.base.ref', '.base.repo.full_name', 'EXPECTED_BODY_SHA', 'ACTUAL_BODY_SHA',
    'git ls-remote --refs origin refs/heads/codex/wallpaper-plugin-development-plan',
    'git merge-base --is-ancestor',
  ]) {
    if (!section.text.includes(token)) violations.push(`missing ${token}`);
  }
  assertNoViolations('plan merge identity', violations);
});

test('BLOCKED_PUSH recovery is task-parametric and response-loss safe', () => {
  const section = developmentSection(/^####\s+4\.1\.4\s+/, 4, 'push recovery');
  const violations = [];
  for (const token of [': "${TASK_ID:?', '--task "$TASK_ID"', 'resumeState', 'expectedSha', 'remote == expectedSha', '禁止重复 push']) {
    if (!section.text.includes(token)) violations.push(`missing ${token}`);
  }
  if (/--task\s+WP-01\b/.test(section.text)) violations.push('push recovery is hard-coded to WP-01');
  if (/retry command/i.test(section.text)) violations.push('stores a free-text retry command');
  assertNoViolations('push recovery contract', violations);
});

test('BLOCKED_PR persists exact identity and reads back before retry', () => {
  const required = ['attempt', 'resumeState', 'expectedHeadSha', 'prNumber', 'observedState', 'readback before retry', 'exact identity', '0 / 1 / >1', '禁止重复 create', '禁止重复 merge'];
  const violations = required.filter((token) => !source.includes(token)).map((token) => `missing ${token}`);
  assertNoViolations('PR recovery contract', violations);
});

test('WP-09 evidence-path is file-addressed single-line transaction-bound and contained', () => {
  const section = sectionForTask('WP-09');
  const violations = [];
  if (/evidence-path\s+--task\s+WP-09/.test(section.text)) violations.push('uses task-addressed evidence-path');
  for (const token of ['stdout exactly one line', 'assert-evidence-path', 'transactionId', 'realpath', 'exclusive-create', 'no-clobber']) {
    if (!section.text.includes(token)) violations.push(`missing ${token}`);
  }
  assertNoViolations('WP-09 evidence path', violations);
});

test('every Plugin commit asserts isolated worktree branch and non-main index first', () => {
  const pluginCommits = [
    ['WP-01', 'implementation'], ['WP-02', 'implementation'], ['WP-03', 'implementation'], ['WP-08', 'implementation'],
    ['WP-09', 'plugin'], ['WP-12A', 'plugin'], ['WP-12B', 'plugin'], ['WP-12C', 'plugin'], ['WP-12D', 'plugin'], ['WP-12E', 'plugin'],
  ];
  const violations = [];
  for (const [task, leg] of pluginCommits) {
    const section = sectionForTask(task);
    const fence = section.fences.find((item) => logicalCommands(item).some(({ text }) => (
      new RegExp(`\\b(?:commit|commit-leg)\\b`).test(text)
      && new RegExp(`--leg\\s+${leg}\\b`).test(text)
      && (new RegExp(`--task\\s+${task}\\b`).test(text) || task === 'WP-09')
    )));
    if (!fence) { violations.push(`${task}/${leg} commit fence missing`); continue; }
    const commands = logicalCommands(fence);
    const commitIndex = commands.findIndex(({ text }) => /\b(?:commit|commit-leg)\b/.test(text) && new RegExp(`--leg\\s+${leg}\\b`).test(text));
    const guardIndex = commands.findIndex(({ text }) => /\bassert-repo-context\b/.test(text) && /--expected-role\s+plugin\b/.test(text) && /--forbid-main-worktree-index\b/.test(text));
    if (guardIndex < 0 || guardIndex > commitIndex) violations.push(`${task}/${leg} lacks pre-commit repository-context guard`);
  }
  for (const token of ['immutable.pluginRoot', 'immutable.pluginBranch', 'symbolic-ref', 'GIT_INDEX_FILE', 'plugin index != wallpaper main index', 'BLOCKED_GIT_STATE']) {
    if (!source.includes(token)) violations.push(`global repo-context contract missing ${token}`);
  }
  assertNoViolations('plugin commit context', violations);
});

test('sensitive validators reject forged and weakened shell-fence mutations', () => {
  const phaseRun = [
    'python3 "$TASK_TOOL" run-phase --task "$TASK_ID" --phase "$PHASE" \\',
    '  --from-catalog --receipt "$PHASE_RECEIPT" --transactions "$TXN_ROOT"',
  ].join('\n');
  const duplicatedPhaseRun = [
    'python3 "$TASK_TOOL" run-phase --task "$TASK_ID" --phase "$PHASE" --from-catalog --receipt "$PHASE_RECEIPT" --transactions "$TXN_ROOT";',
    phaseRun,
  ].join('\n');
  const manifestReadback = 'python3 "$TASK_TOOL" record-manifest-readback --file "$TXN_FILE" --sha256 "$MANIFEST_SHA"';
  const mutationCases = [
    {
      name: 'echo cannot forge seal-evidence',
      mutate: (text) => replaceFirstOccurrence(
        text,
        'python3 "$TASK_TOOL" seal-evidence --task WP-10A \\',
        'echo \'python3 "$TASK_TOOL" seal-evidence --task WP-10A\'',
      ),
      validate: validateEvidenceManifestReadback,
      expected: /WP-10A missing final seal fence/,
    },
    {
      name: 'heredoc body cannot forge manifest readback',
      mutate: (text) => replaceFirstOccurrence(
        text,
        manifestReadback,
        ['cat <<\'FAKE_READBACK\'', manifestReadback, 'FAKE_READBACK'].join('\n'),
      ),
      validate: validateEvidenceManifestReadback,
      expected: /WP-10A does not seal -> readback 64hex/,
    },
    {
      name: 'same fence cannot batch duplicate phase commands',
      mutate: (text) => replaceFirstOccurrence(text, phaseRun, duplicatedPhaseRun),
      validate: validateCorePhaseLedger,
      expected: /single-phase fence has 2 run-phase commands/,
    },
    {
      name: 'WP-INFRA allowlist rejects a missing path',
      mutate: (text) => replaceFirstOccurrence(
        text,
        'git add -- android-car/tests/wp12-bootstrap.test.js\n',
        '',
      ),
      validate: validateInfraBootstrapIntegrity,
      expected: /WP-INFRA git add allowlist mismatch/,
    },
    {
      name: 'WP-INFRA allowlist rejects an extra path',
      mutate: (text) => replaceFirstOccurrence(
        text,
        'git add -- android-car/tests/wallpaper-task-catalog.test.js',
        'git add -- android-car/tests/wallpaper-task-catalog.test.js\ngit add -- android-car/tests/unapproved.test.js',
      ),
      validate: validateInfraBootstrapIntegrity,
      expected: /WP-INFRA git add allowlist mismatch/,
    },
    {
      name: 'WP-INFRA allowlist rejects a duplicate path',
      mutate: (text) => replaceFirstOccurrence(
        text,
        'git add -- android-car/tests/wp11c-transaction.test.js',
        'git add -- android-car/tests/wp11c-transaction.test.js\ngit add -- android-car/tests/wp11c-transaction.test.js',
      ),
      validate: validateInfraBootstrapIntegrity,
      expected: /WP-INFRA git add allowlist mismatch/,
    },
    {
      name: 'WP-INFRA update-ref requires old SHA CAS',
      mutate: (text) => replaceFirstOccurrence(
        text,
        'git update-ref "$CURRENT_REF" "$INFRA_SHA" "$APPROVED_PARENT_SHA"',
        'git update-ref "$CURRENT_REF" "$INFRA_SHA"',
      ),
      validate: validateInfraBootstrapIntegrity,
      expected: /update-ref is missing exact old-SHA CAS/,
    },
    {
      name: 'echo cannot forge manifest readback',
      mutate: (text) => replaceFirstOccurrence(text, manifestReadback, `echo '$(${manifestReadback})'`),
      validate: validateEvidenceManifestReadback,
      expected: /WP-10A does not seal -> readback 64hex/,
    },
    {
      name: 'Plan Commit 2 requires every preimage count guard',
      mutate: (text) => replaceFirstOccurrence(text, '    if old_count != 1:', '    if old_count >= 0:'),
      validate: validatePlanCommit2CountGuards,
      expected: /missing preimage old_count != 1 guard/,
    },
  ];

  for (const mutation of mutationCases) {
    const mutatedDocument = createDocumentModel(mutation.mutate(source));
    const violations = mutation.validate(mutatedDocument);
    assert.match(violations.join('\n'), mutation.expected, mutation.name);
  }
});

function planSection(levelPattern) {
  return developmentDocument.section(levelPattern, 3, levelPattern.source.includes('4\\.5') ? 'plan baseline workflow' : 'plan merge gate');
}

function executableCommands(section) {
  return section.fences.flatMap((fence) => logicalCommands(fence).map((command) => ({ fence, command })));
}

function hasInvocation(command, executable, argvPrefix) {
  return commandInvocations(command).some((invocation) => invocationMatches(invocation, executable, argvPrefix));
}

function gitAddPaths(fence) {
  return logicalCommands(fence).flatMap((command) => commandInvocations(command)
    .filter((invocation) => invocationMatches(invocation, 'git', ['add', '--']))
    .flatMap((invocation) => invocation.argv.slice(3)));
}

function assertExactArray(actual, expected, message) {
  assert.deepEqual(actual, expected, `${message}: ${JSON.stringify(actual)}`);
}

test('§4.5 Commit 2 forbids direct p.write_text(candidate)', () => {
  const section = planSection(/^###\s+4\.5\s+/);
  assert.doesNotMatch(section.text, /\bp\.write_text\s*\(\s*candidate\s*\)/, 'Commit 2 directly overwrites the canonical progress file with p.write_text(candidate)');
});

test('§4.5 Commit 2 persists COMMITTED with EffectiveDone=false', () => {
  const section = planSection(/^###\s+4\.5\s+/);
  const commitFence = section.fences.find((fence) => /git commit -m ['"]docs\(android-car\): record wallpaper plan baseline['"]/.test(fence.code));
  assert.ok(commitFence, 'missing Commit 2 commit fence');
  const commands = logicalCommands(commitFence);
  const commitIndex = commands.findIndex((command) => hasInvocation(command, 'git', ['commit', '-m']));
  const stateCas = commands.slice(commitIndex + 1).find((command) => (
    /\bCOMMITTED\b/.test(command.text)
    && /EffectiveDone/.test(command.text)
    && /(?:false|False)/.test(command.text)
    && /(?:CAS|cas|expected-revision|revision)/.test(command.text)
  ));
  assert.ok(stateCas, 'Commit 2 does not execute a post-commit receipt CAS to COMMITTED/EffectiveDone=false');
});

test('§4.5 plan-only receipt writer is executable durable revision CAS', () => {
  const section = planSection(/^###\s+4\.5\s+/);
  const writer = section.fences.find((fence) => (
    /WP-PLAN-01\.json/.test(fence.code)
    && logicalCommands(fence).some((command) => commandInvocations(command).some((invocation) => ['python3', 'python'].includes(executableName(invocation))))
  ));
  assert.ok(writer, 'missing executable plan-only receipt writer fence for WP-PLAN-01.json');
  for (const [pattern, label] of [
    [/(?:flock|fcntl\.flock)/, 'advisory lock'],
    [/(?:expected_revision|expected-revision|revision\s*(?:!=|==))/, 'revision preimage comparison'],
    [/revision[\s\S]*?\+\s*1/, 'single revision increment'],
    [/(?:mkstemp|NamedTemporaryFile|tempfile)/, 'same-directory temporary file'],
    [/fsync/, 'file fsync'],
    [/(?:os\.)?replace\s*\(/, 'atomic replace'],
    [/(?:O_DIRECTORY|parent[\s\S]*?fsync|dir_fd)/, 'parent-directory fsync'],
  ]) assert.match(writer.code, pattern, `plan-only receipt writer missing ${label}`);
});

test('§4.5 plan-only receipt writer emits newline-delimited valid JSON', () => {
  const section = planSection(/^###\s+4\.5\s+/);
  const writer = section.fences.find((fence) => /def canonical\(value\):/.test(fence.code));
  assert.ok(writer, 'missing plan-only writer canonical serializer');
  assert.ok(
    writer.code.includes('+ \"\\n\").encode()'),
    'canonical serializer does not append a real newline escape',
  );
  assert.ok(
    !writer.code.includes('+ \"\\\\n\").encode()'),
    'canonical serializer appends literal backslash-n and produces invalid JSON receipts',
  );
});

test('§4.5/§4.6 push create and merge execute IN_FLIGHT receipt CAS first', () => {
  const baseline = planSection(/^###\s+4\.5\s+/);
  const merge = planSection(/^###\s+4\.6\s+/);
  const cases = [
    { label: 'push', state: 'PLAN_PUSH_IN_FLIGHT', section: baseline, predicate: (command) => hasInvocation(command, 'git', ['push']) },
    { label: 'create', state: 'PLAN_PR_CREATE_IN_FLIGHT', section: baseline, predicate: (command) => hasInvocation(command, 'gh', ['pr', 'create']) },
    { label: 'merge', state: 'PLAN_PR_MERGE_IN_FLIGHT', section: merge, predicate: (command) => hasInvocation(command, 'gh', ['pr', 'merge']) },
  ];
  const violations = [];
  for (const item of cases) {
    const match = item.section.fences.map((fence) => ({ fence, commands: logicalCommands(fence) }))
      .find(({ commands }) => commands.some(item.predicate));
    if (!match) {
      violations.push(`missing executable ${item.label}`);
      continue;
    }
    const operationIndex = match.commands.findIndex(item.predicate);
    const casBefore = match.commands.slice(0, operationIndex).some((command) => (
      command.text.includes(item.state)
      && /(?:CAS|cas|expected-revision|revision)/.test(command.text)
      && commandInvocations(command).some((invocation) => ['python3', 'python'].includes(executableName(invocation)) || /receipt/.test(executableName(invocation)))
    ));
    if (!casBefore) violations.push(`${item.label} lacks executable ${item.state} receipt CAS before side effect`);
  }
  assertNoViolations('plan external-operation in-flight CAS', violations);
});

test('§4.5/§4.6 PR collection queries use --paginate', () => {
  const sections = [planSection(/^###\s+4\.5\s+/), planSection(/^###\s+4\.6\s+/)];
  const queries = sections.flatMap(executableCommands).flatMap(({ fence, command }) => commandInvocations(command)
    .filter((invocation) => executableName(invocation) === 'gh'
      && invocation.argv[1] === 'api'
      && invocation.argv.some((value) => /\/pulls$/.test(value)))
    .map((invocation) => ({ fence, invocation })));
  assert.ok(queries.length > 0, 'missing executable PR collection query');
  const violations = queries.filter(({ invocation }) => !invocation.argv.includes('--paginate'))
    .map(({ fence }) => `${location(fence)} PR collection query omits --paginate`);
  assertNoViolations('paginated plan PR queries', violations);
});

test('§4.5/§4.6 executable PR lifecycle normalizes CLOSED_UNMERGED', () => {
  const sections = [planSection(/^###\s+4\.5\s+/), planSection(/^###\s+4\.6\s+/)];
  const stateFences = sections.flatMap((section) => section.fences.filter((fence) => /OBSERVED_STATE/.test(fence.code)));
  assert.ok(stateFences.length > 0, 'missing executable PR lifecycle state readback');
  const violations = stateFences.filter((fence) => !/CLOSED_UNMERGED/.test(fence.code))
    .map((fence) => `${location(fence)} does not emit/handle CLOSED_UNMERGED`);
  assertNoViolations('CLOSED_UNMERGED lifecycle', violations);
});

test('§4.6 strict merged readback rejects merged_at=null', () => {
  const section = planSection(/^###\s+4\.6\s+/);
  const strictNullGuard = section.fences.some((fence) => (
    /(?:jq\s+-e[^\n]*\.merged_at\s*!=\s*null|test\s+"\$PLAN_MERGED_AT"\s+!=\s+null|\[\[\s+"\$PLAN_MERGED_AT"\s+!=\s+null)/.test(fence.code)
  ));
  assert.ok(strictNullGuard, 'merged readback only checks non-empty text and would accept merged_at=null');
});

test('§4.6 authoritative base uses exact ls-remote reconciliation', () => {
  const section = planSection(/^###\s+4\.6\s+/);
  const commands = executableCommands(section);
  const remote = commands.find(({ command }) => commandInvocations(command).some((invocation) => (
    executableName(invocation) === 'git'
    && invocation.argv[1] === 'ls-remote'
    && invocation.argv.includes('--exit-code')
    && invocation.argv.includes('--refs')
    && invocation.argv.includes('origin')
    && invocation.argv.includes('refs/heads/huawei-android12-car')
  )));
  assert.ok(remote, 'missing exact authoritative-base git ls-remote --exit-code --refs reconciliation');
  const assignment = remote.command.text.match(/^([A-Z][A-Z0-9_]*)=/);
  assert.ok(assignment, 'authoritative-base ls-remote result is not frozen in a variable');
  const variable = assignment[1];
  assert.ok(commands.some(({ command }) => (
    new RegExp(`\\$${variable}\\b`).test(command.text)
    && /\$BASE_SHA\b/.test(command.text)
    && commandInvocations(command).some((invocation) => executableName(invocation) === 'test')
  )), 'authoritative-base ls-remote SHA is not compared exactly with BASE_SHA');
});

test('§4.5 Commit 1 and Commit 2 enforce staged and committed exact path sets', () => {
  const section = planSection(/^###\s+4\.5\s+/);
  const commit1Paths = [
    'android-car/AGENTS.md',
    'android-car/README.zh-CN.md',
    'android-car/docs/ALIGNMENT-WINDOWS.zh-CN.md',
    'android-car/docs/BOUNDARIES.zh-CN.md',
    'android-car/docs/DEVELOPMENT.zh-CN.md',
    'android-car/docs/FEATURE-MATRIX.zh-CN.md',
    'android-car/docs/STAGE-GAPS.zh-CN.md',
    'android-car/docs/WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md',
    'android-car/tests/wallpaper-plugin-development-doc.test.js',
  ];
  const commit2Paths = ['android-car/docs/WALLPAPER-PLUGIN-PROGRESS.zh-CN.md'];
  const commit1Prepare = section.fences.find((fence) => gitAddPaths(fence).includes('android-car/AGENTS.md'));
  const commit2Prepare = section.fences.find((fence) => gitAddPaths(fence).includes(commit2Paths[0]));
  const commit1Commit = section.fences.find((fence) => /git commit -m ['"]docs\(android-car\): plan isolated wallpaper plugin runtime['"]/.test(fence.code));
  const commit2Commit = section.fences.find((fence) => /git commit -m ['"]docs\(android-car\): record wallpaper plan baseline['"]/.test(fence.code));
  assert.ok(commit1Prepare && commit2Prepare && commit1Commit && commit2Commit, 'missing plan commit prepare/commit fence');
  assertExactArray(gitAddPaths(commit1Prepare), commit1Paths, 'Commit 1 git add allowlist mismatch');
  assertExactArray(gitAddPaths(commit2Prepare), commit2Paths, 'Commit 2 git add allowlist mismatch');

  const violations = [];
  for (const [label, prepare, commit, expected] of [
    ['Commit 1', commit1Prepare, commit1Commit, commit1Paths],
    ['Commit 2', commit2Prepare, commit2Commit, commit2Paths],
  ]) {
    const prepareCommands = logicalCommands(prepare);
    const lastAdd = prepareCommands.map((command, index) => hasInvocation(command, 'git', ['add', '--']) ? index : -1).reduce((a, b) => Math.max(a, b), -1);
    const stagedCheck = prepareCommands.slice(lastAdd + 1).some((command) => (
      hasInvocation(command, 'git', ['diff', '--cached', '--name-only'])
      && /(?:^|\s)(?:test|diff|cmp)(?:\s|$)/.test(command.text)
    ));
    if (!stagedCheck || !expected.every((pathName) => prepare.code.includes(pathName))) violations.push(`${label} lacks post-add staged exact-set assertion`);

    const committedCheck = logicalCommands(commit).some((command) => (
      hasInvocation(command, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r'])
      && /(?:^|\s)test(?:\s|$)/.test(command.text)
      && expected.every((pathName) => commit.code.includes(pathName))
    ));
    if (!committedCheck) violations.push(`${label} lacks committed exact-set assertion`);
  }
  assertNoViolations('plan commit exact path sets', violations);
});
