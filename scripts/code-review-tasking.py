#!/usr/bin/env python3
"""Create/verify the source-bound code-review TD map; never implement its tasks.

Run with --apply once (resumable), or --verify for read-only tracker validation.
Local journal is ignored; the public task map and verification live with the review.
"""
import argparse

import csv
import hashlib
import json
from pathlib import Path

import subprocess

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'docs/code-review-2026-09-08'
JOURNAL = ROOT / '.todos/code-review-tasking.json'
MARKER = 'Estimate: <= 15 minutes for a junior developer; stop after this single vertical slice.'
EPICS = {
    'data': ('Keep card mutations isolated and reference counts exact', 'UUID response mapping, project-scoped reads/writes, linked-face project identity, exact reference counts and project-local ordering have focused regression evidence.'),
    'operations': ('Make asynchronous operations settle and respect current user intent', 'Import, worker, editor and search operations expose settled completion, own cancellation, reject stale mutations and release resources without affecting other operations.'),
    'transport': ('Enforce provider request policy and private API boundaries', 'Direct Scryfall dispatch is FIFO concurrency one with minimum spacing; private API access is authenticated and scoped; proxy destinations and requests are bounded; deadlines and disconnect cleanup are verified.'),
    'resources': ('Bound image and PDF resource ownership', 'Decode, rendering, cache, upload and subprocess admission obey explicit resource budgets. Native context claims have real evidence or an honest blocked disposition, and no speculative corruption fix is reported as proven.'),
    'performance': ('Remove repeated lookup work and make outputs deterministic', 'Named quadratic lookup kernels become expected linear passes; duplicate scoring/cache work is removed; archive ordering and rendition identity remain correct; cache maintenance is bounded.'),
    'persistence': ('Make backup and calibration persistence complete and atomic', 'All exported state changes trigger backup; malformed imports fail before writes; project import and profile replacement are atomic; concurrency preserves data; grouped calibration preserves exact ordering and offsets.'),
    'preferences': ('Reuse cancellable immutable MPC preference context', 'Modal and held-out consumers share version-keyed seed profiles with bounded search/decode work, subscriber-safe cancellation and independent fold training.'),
    'desktop': ('Make desktop services and IPC lifecycle-owned', 'Microservice supervision owns timers/readiness/restart budgets; shutdown waits safely; IPC listeners dispose; settings persist atomically; actual preload compatibility has evidence or explicit follow-up.'),
    'build': ('Make build and release inputs deterministic and safe', 'Shared artifacts precede consumers without destructive races; validation gates fail closed; release prompts are data not shell syntax; binary paths and Python runtime are reproducible and standalone-image smoke is recorded.'),
    'evidence': ('Publish focused regression and runtime evidence for review remediation', 'Performance, native lifecycle and calibration probes are tied to tested source; legacy live tests and misleading docs are corrected; hypotheses are not called fixed without evidence and required follow-ups remain tracked.'),
}


def td(*args):
    result = subprocess.run(['td', *args], cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'td {args[0]} failed: {result.stderr or result.stdout}')
    return result.stdout


def td_json(*args):
    return json.loads(td(*args, '--json'))


def persist(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def load_spec():
    evidence = json.loads((REPORT / 'verification.json').read_text())
    findings = {entry['id']: entry for entry in evidence['findings']}
    for name, digest in evidence['document_sha256'].items():
        assert hashlib.sha256((REPORT / name).read_bytes()).hexdigest() == digest, name
    with (REPORT / 'tasking-slices.tsv').open() as source:
        rows = list(csv.DictReader(source, delimiter='\t'))
    by_key = {row['key']: row for row in rows}
    assert len(by_key) == len(rows)
    covered = set()
    graph = {}
    for row in rows:
        assert row['epic'] in EPICS
        assert row['title'] and row['acceptance']
        row['sources'] = row['findings'].split(',')
        row['deps'] = row['depends'].split(',') if row['depends'] else []
        assert set(row['deps']) <= set(by_key)
        assert set(row['sources']) <= set(findings)
        covered.update(row['sources'])
        graph[row['key']] = set(row['deps'])
        levels = {'High': 1, 'Medium': 2, 'Low': 3}
        row['priority'] = 'P' + str(min(levels[findings[f]['severity']] for f in row['sources']))
        citations = []
        for finding in row['sources']:
            report = findings[finding]['report']
            citations.append(f"{finding}: docs/code-review-2026-09-08/{report}; SHA256 {evidence['document_sha256'][report]}")
        row['description'] = (
            f"Single operation: {row['title']}.\n\n"
            f"Task slice key: {row['key']} (separate namespace from review finding IDs).\n"
            f"Reviewed source: {evidence['reviewed_commit']}.\n" + '\n'.join(citations) +
            '\n\nRead the referenced finding and its source/callers before editing; revalidate against current source. '
            'Implement only this operation and its focused regression, or perform only the stated probe/document decision. '
            'No unrelated refactor, commit, deployment, credential logging, GitHub Actions or sibling-repository edits. '
            'Preserve project isolation, deterministic output, preload security, SSE compression exclusion and direct-Scryfall concurrency-one/100ms policy. '
            'A runtime hypothesis is not an established defect; evidence-gated disposition must identify any required atomic follow-ups. '
            'If this slice exceeds the estimate, stop and split the remaining operation into child-epic tasks instead of broadening this ticket.\n\n' + MARKER
        )
        row['full_acceptance'] = (
            row['acceptance'] + '\n'
            'Attach the exact focused test/probe command and real result, or the requested document diff. '
            'Identify the tested source commit/tree and relevant file changes. '
            'Runtime-unavailable is blocked, not passed; never substitute mock behavior for a required real-runtime probe. '
            'No changes outside this operation except its necessary focused test or type declaration.'
        )
    assert covered == set(findings), sorted(set(findings) - covered)
    done = set()
    while graph:
        ready = {key for key, deps in graph.items() if deps <= done}
        assert ready, 'Dependency cycle'
        done.update(ready)
        graph = {key: deps for key, deps in graph.items() if key not in ready}
    return evidence, rows


def dependency_ids(record):
    return {item if isinstance(item, str) else item['id'] for item in record['dependencies']}


def apply(state, rows):
    existing = td_json('list', '--all', '--labels', state['label'], '--limit', '10000')
    for key, (title, acceptance) in EPICS.items():
        if key in state['epics']:
            continue
        matches = [item for item in existing if item['title'] == title and item.get('parent_id') == state['program_id']]
        assert len(matches) <= 1
        if matches:
            ident = matches[0]['id']
        else:
            result = td_json('create', title, '--type', 'epic', '--epic', state['program_id'], '--priority', 'P1',
                             '--labels', state['label'] + ',cr-' + key,
                             '--description', 'Outcome epic for docs/code-review-2026-09-08/README.md. Children are independent single-operation slices, not a bundled implementation. ' + acceptance,
                             '--acceptance', acceptance + ' All linked child tasks require actual closure evidence; newly discovered necessary follow-ups stay under this epic.')
            ident = result['id']
        state['epics'][key] = ident
        persist(JOURNAL, state)
    for index, row in enumerate(rows, 1):
        key = row['key']
        if key in state['tasks']:
            continue
        label = 'cr-slice-' + key.lower()
        matches = [item for item in existing if label in item.get('labels', [])]
        assert len(matches) <= 1
        if matches:
            ident = matches[0]['id']
        else:
            result = td_json('create', row['title'], '--type', 'task', '--epic', state['epics'][row['epic']], '--points', '1',
                             '--priority', row['priority'], '--labels', ','.join([state['label'], label, 'cr-' + row['epic']] + ['finding-' + f.lower() for f in row['sources']]),
                             '--description', row['description'], '--acceptance', row['full_acceptance'])
            ident = result['id']
        state['tasks'][key] = ident
        persist(JOURNAL, state)
        if index % 20 == 0:
            print(f'Created/read back task IDs: {index}/{len(rows)}', flush=True)
    for row in rows:
        ident = state['tasks'][row['key']]
        wanted = {state['tasks'][key] for key in row['deps']}
        actual = dependency_ids(td_json('dep', ident))
        assert actual <= wanted, f'Unexpected external dependencies on {ident}'
        for blocker in sorted(wanted - actual):
            td('dep', 'add', ident, blocker)
        verified = dependency_ids(td_json('dep', ident))
        assert verified == wanted
    state['dependencies'] = sorted([[state['tasks'][r['key']], state['tasks'][d]] for r in rows for d in r['deps']])
    persist(JOURNAL, state)


def verify(state, rows, evidence):
    assert set(state['epics']) == set(EPICS)
    assert set(state['tasks']) == {r['key'] for r in rows}
    root = td_json('list', '--id', state['program_id'], '--all', '--limit', '10000')
    assert len(root) == 1 and root[0]['type'] == 'epic' and root[0].get('acceptance')
    epics = td_json('list', '--parent', state['program_id'], '--all', '--limit', '10000')
    assert {e['id'] for e in epics} == set(state['epics'].values())
    for epic in epics:
        assert epic['type'] == 'epic' and epic['parent_id'] == state['program_id'] and epic.get('acceptance')
        assert not dependency_ids(td_json('dep', epic['id'])), 'No whole-epic ordering is intended'
    actual_tasks = {}
    for key, epic_id in state['epics'].items():
        tasks = td_json('list', '--parent', epic_id, '--all', '--limit', '10000')
        expected = {state['tasks'][r['key']] for r in rows if r['epic'] == key}
        assert {t['id'] for t in tasks} == expected
        for task in tasks:
            assert task['parent_id'] == epic_id and task['type'] == 'task' and task['points'] == 1
            assert MARKER in task['description'] and task.get('acceptance')
            actual_tasks[task['id']] = task
    edges = set()
    for row in rows:
        ident = state['tasks'][row['key']]
        task = actual_tasks[ident]
        assert task['title'] == row['title']
        assert task['description'] == row['description']
        assert task['acceptance'] == row['full_acceptance']
        assert task['priority'] == row['priority']
        edges.update((ident, d) for d in dependency_ids(td_json('dep', ident)))
    wanted_edges = {(state['tasks'][r['key']], state['tasks'][d]) for r in rows for d in r['deps']}
    assert edges == wanted_edges
    all_program = td_json('list', '--all', '--labels', state['label'], '--limit', '10000')
    assert {i['id'] for i in all_program} == {state['program_id']} | set(state['epics'].values()) | set(state['tasks'].values())
    frontier = td_json('critical-path', '--limit', '10000')
    persist(REPORT / 'tasking-critical-path.json', frontier)
    raw_ready = frontier.get('ready_to_start', [])
    ready_ids = {item if isinstance(item, str) else item['id'] for item in raw_ready}
    ready = sorted(ready_ids & set(state['tasks'].values()))
    # Task map is a new artifact: original review and verification hashes stay untouched.
    snapshot = {
        'program': root[0], 'epics': epics, 'tasks': list(actual_tasks.values()),
        'source_review_commit': evidence['reviewed_commit'],
        'source_report_sha256': evidence['document_sha256'],
        'dependencies': sorted([list(e) for e in edges]),
        'finding_to_task_ids': {f['id']: [state['tasks'][r['key']] for r in rows if f['id'] in r['sources']] for f in evidence['findings']},
        'slice_to_task_ids': state['tasks'], 'ready_leaf_ids': ready,
        'counts': {'program_epics': 1, 'outcome_epics': len(epics), 'leaf_tasks': len(actual_tasks), 'dependency_edges': len(edges), 'findings_covered': len(evidence['findings']), 'ready_leaf_tasks': len(ready)},
        'checks': {'exact_parent_membership': True, 'exact_dependency_pairs': True, 'one_point_tasks': True, 'acceptance_exact': True, 'sizing_marker_present': True, 'source_report_hashes_match': True, 'dependency_graph_acyclic': True},
        'note': 'No implementation tasks started. Outcome epics may overlap in time; ordering is at leaf level only. Logical slice keys are distinct from finding IDs.',
    }
    persist(REPORT / 'tasking-verification.json', snapshot)
    lines = ['# Code-review TD action map', '', f"Program epic: **{state['program_id']}** — {root[0]['title']}", '',
             f"{len(rows)} single-operation tasks under {len(epics)} outcome epics; all {len(evidence['findings'])} findings covered. {len(edges)} explicit prerequisite edges.", '',
             'Each leaf is type task, one point, with explicit acceptance and a <=15-minute sizing/stop rule. If actual complexity exceeds the estimate, split before broadening implementation. Tests belonging to the same behavior are closure evidence, not a second implementation operation.', '',
             'Source: [review](README.md), reviewed commit `' + evidence['reviewed_commit'] + '`. The original review documents and verification hashes are unchanged.', '',
             'There are no whole-epic dependencies: these are concurrent outcome groups, not sequential phases. Cross-epic prerequisites are explicit on leaf tasks. Hypothesis tasks require real probes followed by a disposition; evidence of a defect requires new atomic remediation children before the parent outcome can close.', '',
             'All tasks remain unclaimed/open at creation. No implementation, commits or deployments were performed. Logical slice keys below are not review finding IDs.', '']
    for key, (title, _) in EPICS.items():
        subset = [r for r in rows if r['epic'] == key]
        lines += [f"## {state['epics'][key]} — {title}", '', f'{len(subset)} tasks.', '', '| TD ID | Slice | Finding(s) | Single operation | Blocked by |', '|---|---|---|---|---|']
        for row in subset:
            blockers = ', '.join(state['tasks'][d] for d in row['deps']) or 'None'
            lines.append(f"| {state['tasks'][row['key']]} | {row['key']} | {row['findings']} | {row['title']} | {blockers} |")
        lines.append('')
    lines += ['## Finding coverage', '', '| Finding | Task IDs |', '|---|---|']
    for finding, ids in snapshot['finding_to_task_ids'].items():
        lines.append(f"| {finding} | {', '.join(ids)} |")
    lines += ['', '## Dependency-ready leaf tasks', '', 'Read from TD critical-path output and intersected with this exact program, not inferred from a global ready list.', '']
    for ident in ready:
        lines.append(f"- {ident}: {actual_tasks[ident]['title']}")
    lines += ['', '## Verification artifacts', '', '- tasking-verification.json: persisted issue fields, membership, acceptance, dependency pairs, coverage and frontier.', '- tasking-critical-path.json: actual TD frontier output.', '- tasking-slices.tsv: input operation/acceptance/dependency specification.', '- Helper: repository-root scripts/code-review-tasking.py. Use --verify for readback; --apply resumes creation and verifies.', '- Ignored recovery journal: .todos/code-review-tasking.json.', '']
    (REPORT / 'TASKS.md').write_text('\n'.join(lines))
    print(json.dumps(snapshot['counts'], indent=2))
    print('All persisted parent, type, sizing, acceptance and dependency assertions passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--apply', action='store_true')
    modes.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    evidence, rows = load_spec()
    state = json.loads(JOURNAL.read_text())
    if args.apply:
        apply(state, rows)
    verify(state, rows, evidence)


if __name__ == '__main__':
    main()
