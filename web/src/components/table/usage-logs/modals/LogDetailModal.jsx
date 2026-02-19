import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  Tabs,
  TabPane,
  Button,
  Spin,
  Toast,
  Tag,
  Space,
  Empty,
  Collapsible,
  Typography,
} from '@douyinfe/semi-ui';
import { IconCopy, IconChevronDown, IconChevronRight } from '@douyinfe/semi-icons';
import { useTranslation } from 'react-i18next';
import { API } from '../../../../helpers';

const preStyle = {
  maxHeight: '60vh',
  overflow: 'auto',
  background: 'var(--semi-color-fill-0)',
  padding: '12px',
  borderRadius: '6px',
  fontFamily: 'monospace',
  fontSize: '13px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  margin: 0,
  lineHeight: 1.6,
};

const detectSSEFormat = (content) => {
  const lines = (content || '').split('\n');
  const eventLines = lines.filter((l) => l.startsWith('event: '));
  const dataLines = lines.filter(
    (l) => l.startsWith('data: ') && l !== 'data: [DONE]',
  );

  if (dataLines.length === 0) return null;

  // Check Anthropic format via event names
  if (
    eventLines.some(
      (l) =>
        l.includes('message_start') || l.includes('content_block_delta'),
    )
  ) {
    return 'anthropic';
  }

  // Check OpenAI Responses format via event names
  if (eventLines.some((l) => /^event: response\./.test(l))) {
    return 'responses';
  }

  // Parse first few data lines to detect format
  for (const line of dataLines.slice(0, 5)) {
    try {
      const obj = JSON.parse(line.slice(6));
      if (obj.candidates) return 'gemini';
      if (obj.choices && obj.choices[0]?.delta !== undefined) return 'openai';
      if (
        obj.type === 'message_start' ||
        obj.type === 'content_block_start'
      )
        return 'anthropic';
      if (typeof obj.type === 'string' && obj.type.startsWith('response.'))
        return 'responses';
    } catch {
      // skip
    }
  }

  return 'openai'; // default fallback
};

const buildMergedContentOpenAI = (content) => {
  const lines = (content || '').split('\n');
  const chunks = [];
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        chunks.push(JSON.parse(line.slice(6)));
      } catch {
        // skip
      }
    }
  }
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const last = chunks[chunks.length - 1];

  let role = '';
  let contentParts = [];
  let reasoningParts = [];
  let toolCalls = {};
  let finishReason = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.role && !role) role = delta.role;
    if (delta.content) contentParts.push(delta.content);
    if (delta.reasoning_content) reasoningParts.push(delta.reasoning_content);
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
        }
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: role || 'assistant' };
  if (contentParts.length > 0) message.content = contentParts.join('');
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
  const toolCallsArr = Object.keys(toolCalls).sort((a, b) => a - b).map(k => toolCalls[k]);
  if (toolCallsArr.length > 0) message.tool_calls = toolCallsArr;

  const merged = {
    id: first.id || '',
    object: 'chat.completion',
    created: first.created || 0,
    model: first.model || '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (last.usage) merged.usage = last.usage;

  return JSON.stringify(merged, null, 2);
};

const buildMergedContentAnthropic = (content) => {
  const lines = (content || '').split('\n');
  let currentEvent = '';
  const events = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        // skip
      }
    }
  }

  if (events.length === 0) return null;

  let message = null;
  const contentBlocks = [];
  let currentBlock = null;
  let stopReason = null;
  let outputUsage = {};

  for (const { data } of events) {
    if (data.type === 'message_start' && data.message) {
      message = { ...data.message };
    } else if (data.type === 'content_block_start') {
      currentBlock = { ...data.content_block, _text: '', _input_json: '' };
    } else if (data.type === 'content_block_delta' && currentBlock) {
      if (data.delta?.type === 'text_delta') {
        currentBlock._text += data.delta.text || '';
      } else if (data.delta?.type === 'thinking_delta') {
        currentBlock._text += data.delta.thinking || '';
      } else if (data.delta?.type === 'input_json_delta') {
        currentBlock._input_json += data.delta.partial_json || '';
      }
    } else if (data.type === 'content_block_stop') {
      if (currentBlock) {
        contentBlocks.push(currentBlock);
        currentBlock = null;
      }
    } else if (data.type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) outputUsage = data.usage;
    }
  }

  if (!message) return null;

  const mergedContent = contentBlocks.map((block) => {
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block._text };
    } else if (block.type === 'tool_use') {
      let input = {};
      try {
        input = JSON.parse(block._input_json || '{}');
      } catch {
        // skip
      }
      return { type: 'tool_use', id: block.id, name: block.name, input };
    }
    return { type: 'text', text: block._text };
  });

  const merged = {
    id: message.id,
    type: 'message',
    role: message.role || 'assistant',
    model: message.model,
    content: mergedContent,
    stop_reason: stopReason || message.stop_reason,
    usage: { ...(message.usage || {}), ...outputUsage },
  };

  return JSON.stringify(merged, null, 2);
};

const buildMergedContentGemini = (content) => {
  const lines = (content || '').split('\n');
  const chunks = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        chunks.push(JSON.parse(line.slice(6)));
      } catch {
        // skip
      }
    }
  }
  if (chunks.length === 0) return null;

  const textParts = [];
  const thoughtParts = [];
  let model = '';
  let usageMetadata = null;

  for (const chunk of chunks) {
    if (chunk.modelVersion && !model) model = chunk.modelVersion;
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
    for (const candidate of chunk.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (part.thought && part.text) {
          thoughtParts.push(part.text);
        } else if (part.text) {
          textParts.push(part.text);
        }
      }
    }
  }

  const parts = [];
  if (thoughtParts.length > 0) {
    parts.push({ thought: true, text: thoughtParts.join('') });
  }
  if (textParts.length > 0) {
    parts.push({ text: textParts.join('') });
  }

  const merged = {
    candidates: [{ content: { parts, role: 'model' } }],
  };
  if (model) merged.modelVersion = model;
  if (usageMetadata) merged.usageMetadata = usageMetadata;

  return JSON.stringify(merged, null, 2);
};

const buildMergedContentResponses = (content) => {
  const lines = (content || '').split('\n');
  let currentEvent = '';
  const events = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        // skip
      }
    }
  }

  if (events.length === 0) return null;

  // If response.completed exists, use its full response object
  const completedEvent = events.find(
    (e) => e.event === 'response.completed',
  );
  if (completedEvent?.data?.response) {
    return JSON.stringify(completedEvent.data.response, null, 2);
  }

  // Fallback: accumulate text from deltas
  const textParts = [];
  let responseObj = null;

  for (const { event, data } of events) {
    if (event === 'response.created' && data) {
      responseObj = data;
    }
    if (event === 'response.output_text.delta' && data?.delta) {
      textParts.push(data.delta);
    }
  }

  if (responseObj && textParts.length > 0) {
    const result = { ...responseObj };
    if (Array.isArray(result.output)) {
      for (const item of result.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text') {
              c.text = textParts.join('');
            }
          }
        }
      }
    }
    return JSON.stringify(result, null, 2);
  }

  return responseObj ? JSON.stringify(responseObj, null, 2) : null;
};

const buildMergedContent = (content) => {
  const format = detectSSEFormat(content);
  if (!format) return null;

  switch (format) {
    case 'anthropic':
      return buildMergedContentAnthropic(content);
    case 'gemini':
      return buildMergedContentGemini(content);
    case 'responses':
      return buildMergedContentResponses(content);
    case 'openai':
    default:
      return buildMergedContentOpenAI(content);
  }
};

const headerPreStyle = {
  ...preStyle,
  maxHeight: '30vh',
};

const HeaderSection = ({ header, t }) => {
  const [open, setOpen] = useState(false);

  if (!header) return null;

  let formatted = header;
  try {
    formatted = JSON.stringify(JSON.parse(header), null, 2);
  } catch {
    // use raw string
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}
        onClick={() => setOpen(!open)}
      >
        {open ? <IconChevronDown size='small' /> : <IconChevronRight size='small' />}
        <Typography.Text strong size='small'>{t('请求头')}</Typography.Text>
      </div>
      <Collapsible isOpen={open} keepDOM>
        <pre style={headerPreStyle}>{formatted}</pre>
      </Collapsible>
    </div>
  );
};

const TabContent = ({ content, header, defaultMerged, defaultFormatted, t }) => {
  const [formatted, setFormatted] = useState(false);
  const [displayContent, setDisplayContent] = useState('');
  const [mergedView, setMergedView] = useState(false);

  useEffect(() => {
    setFormatted(false);
    const isSSE = (content || '').includes('data: {');
    if (defaultMerged && isSSE) {
      const merged = buildMergedContent(content);
      if (merged) {
        setDisplayContent(merged);
        setMergedView(true);
        return;
      }
    }
    setMergedView(false);
    if (defaultFormatted && content) {
      try {
        const parsed = JSON.parse(content);
        setDisplayContent(JSON.stringify(parsed, null, 2));
        setFormatted(true);
        return;
      } catch {
        // not JSON, fall through to raw display
      }
    }
    setDisplayContent(content || '');
  }, [content, defaultMerged, defaultFormatted]);

  const handleFormat = useCallback(() => {
    if (formatted) {
      setFormatted(false);
      setDisplayContent(content || '');
      return;
    }
    try {
      const parsed = JSON.parse(content);
      setDisplayContent(JSON.stringify(parsed, null, 2));
      setFormatted(true);
    } catch {
      Toast.warning(t('非有效JSON'));
    }
  }, [content, formatted, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content || '');
      Toast.success(t('复制成功'));
    } catch {
      Toast.error(t('复制失败'));
    }
  }, [content, t]);

  const handleMergedView = useCallback(() => {
    if (mergedView) {
      setMergedView(false);
      setDisplayContent(content || '');
      setFormatted(false);
      return;
    }
    const merged = buildMergedContent(content);
    if (merged) {
      setDisplayContent(merged);
      setMergedView(true);
      setFormatted(false);
    } else {
      Toast.warning(t('非有效JSON'));
    }
  }, [content, mergedView, t]);

  if (!content) {
    return <Empty description={t('暂无数据')} />;
  }

  const isSSE = content.includes('data: {');

  return (
    <div>
      <HeaderSection header={header} t={t} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginBottom: 8,
        }}
      >
        {isSSE && (
          <Button size='small' onClick={handleMergedView}>
            {mergedView ? t('原始数据') : t('整合视图')}
          </Button>
        )}
        <Button size='small' onClick={handleFormat} disabled={mergedView}>
          {formatted ? t('原始数据') : t('格式化')}
        </Button>
        <Button size='small' icon={<IconCopy />} onClick={handleCopy}>
          {t('复制')}
        </Button>
      </div>
      <pre style={preStyle}>{displayContent}</pre>
    </div>
  );
};

const LogDetailModal = ({
  visible,
  logId,
  onClose,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible || !logId) {
      setDetail(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    API.get(`/api/log/${logId}/detail`)
      .then((res) => {
        const { success, data, message } = res.data;
        if (success) {
          setDetail(data);
        } else {
          setError(message || t('加载失败'));
        }
      })
      .catch(() => {
        setError(t('加载失败'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [visible, logId, t]);

  return (
    <Modal
      title={t('请求/响应详情')}
      visible={visible}
      onCancel={onClose}
      footer={null}
      width='90vw'
      bodyStyle={{ maxHeight: '80vh', overflow: 'auto' }}
      closeOnEsc
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin size='large' tip={t('加载中...')} />
        </div>
      ) : error ? (
        <Empty description={error} />
      ) : detail ? (
        <Tabs>
          <TabPane tab={t('下游请求')} itemKey='downstream_request'>
            <TabContent content={detail.downstream_request} header={detail.downstream_request_header} defaultFormatted t={t} />
          </TabPane>
          <TabPane tab={t('上游请求')} itemKey='upstream_request'>
            <TabContent content={detail.upstream_request} header={detail.upstream_request_header} defaultFormatted t={t} />
          </TabPane>
          <TabPane tab={t('上游响应')} itemKey='upstream_response'>
            <TabContent content={detail.upstream_response} header={detail.upstream_response_header} defaultMerged t={t} />
          </TabPane>
          <TabPane tab={t('下游响应')} itemKey='downstream_response'>
            <TabContent content={detail.downstream_response} header={detail.downstream_response_header} defaultMerged t={t} />
          </TabPane>
        </Tabs>
      ) : (
        <Empty description={t('暂无数据')} />
      )}
    </Modal>
  );
};

export default LogDetailModal;
