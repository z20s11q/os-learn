import type { Curriculum, Frame } from '../types';
import { Panel } from './Panel';

/**
 * 右侧讲解面板（T08/T10）。
 *
 * 展示本帧 `lesson` 字段中已匹配的教学点；lesson 为空时展示本停点的匹配状态。
 * 数值来自帧内字段与证据引用，文案解释机制。
 */
export function ExplanationPanel({
  frame,
  curriculum,
  pending,
  busyLabel,
}: {
  frame: Frame;
  curriculum: Curriculum | null;
  pending: boolean;
  busyLabel: string | null;
}) {
  const lesson = frame.lesson;
  const current = frame.os?.current ?? null;
  const selected = frame.os?.selected ?? null;

  return (
    <Panel
      title="本步讲解"
      testId="panel-explanation"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        lesson ? (
          <>
            <span className="badge ok">{lesson.lessonId}</span>
            <span className="badge">{lesson.stage}</span>
            <span className={'badge ' + (lesson.checksPassed ? 'ok' : 'warn')}>
              {lesson.checksPassed ? '检查通过' : '检查有差异'}
            </span>
          </>
        ) : (
          <span className="badge unavailable">未绑定</span>
        )
      }
    >
      {lesson ? (
        <>
          <h2 className="lesson-title">{lesson.title}</h2>
          <p className="lesson-purpose">{lesson.explain.purpose}</p>

          <h3>输入 / 输出</h3>
          <p>{lesson.explain.io}</p>

          <h3>关键指令 / 函数</h3>
          <dl className="explain-list">
            {Object.entries(lesson.explain.instructions ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt className="mono">{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <h3>原理</h3>
          <ul className="tight">
            {lesson.explain.concepts.map((concept, index) => (
              <li key={index}>{concept}</li>
            ))}
          </ul>

          <h3>本帧事实</h3>
          <table className="kv">
            <tbody>
              <tr>
                <td className="key">停止原因</td>
                <td className="val mono">{frame.stop.reason}</td>
              </tr>
              <tr>
                <td className="key">PC</td>
                <td className="val mono">{frame.stop.pc ?? '未采集'}</td>
              </tr>
              <tr>
                <td className="key">current</td>
                <td className="val mono">
                  {current ? `pid=${current.pid} ${current.comm} (${current.state})` : '未采集'}
                </td>
              </tr>
              <tr>
                <td className="key">选中</td>
                <td className="val mono">
                  {selected ? `pid=${selected.pid} ${selected.comm}` : '未采集'}
                </td>
              </tr>
              <tr>
                <td className="key">采集 ID</td>
                <td className="val mono">{frame.captureId}</td>
              </tr>
            </tbody>
          </table>

          {lesson.checksDiff && lesson.checksDiff.length > 0 ? (
            <div className="diff-box">
              <b>检查差异</b>
              <ul className="tight">
                {lesson.checksDiff.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {lesson.questions.length > 0 ? (
            <>
              <h3>先预测，再看证据</h3>
              <ol className="tight">
                {lesson.questions.map((question, index) => (
                  <li key={index}>
                    {question.prompt}
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      证据：{question.evidenceRefs.join('、')}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          <p className="muted evidence-line">
            匹配依据：{lesson.reason}；课程版本 {curriculum?.version ?? '—'}
          </p>
        </>
      ) : (
        <div>
          <p>本停点教学点未绑定。</p>
          <p className="muted">
            课程按本帧 PC、符号、进程和停止原因匹配；这里展示本停点的状态与证据。
            可以继续单步、设断点，或从下方时间线选择已有教学点。
          </p>
          {frame.source ? (
            <table className="kv">
              <tbody>
                <tr>
                  <td className="key">当前符号</td>
                  <td className="val mono">{frame.source.symbol}</td>
                </tr>
                <tr>
                  <td className="key">模块 / 行</td>
                  <td className="val mono">
                    {frame.source.module} / {frame.source.line}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="unavailable">本帧源码符号缺失；符号来源与加载状态见代码面板和证据引用。</p>
          )}
          {curriculum ? (
            <p className="muted">
              已加载 {curriculum.lessons.length} 课；不可用 {curriculum.unavailable.length} 课。
            </p>
          ) : null}
        </div>
      )}

      <h3>证据引用</h3>
      <table className="kv">
        <tbody>
          {Object.entries(frame.evidence ?? {}).map(([key, value]) => (
            <tr key={key}>
              <td className="key mono">{key}</td>
              <td className="val">
                <span className={'badge ' + (value.kind === 'unavailable' ? 'unavailable' : value.kind === 'observed' ? 'ok' : 'decoded')}>
                  {value.kind}
                </span>{' '}
                <span className="mono" style={{ fontSize: 11 }}>
                  {value.source}
                  {value.refs?.length ? ` · ${value.refs.join(' · ')}` : ''}
                </span>
                {value.reason ? <div className="muted" style={{ fontSize: 11 }}>{value.reason}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
