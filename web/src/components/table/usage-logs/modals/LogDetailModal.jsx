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
} from '@douyinfe/semi-ui';
import { IconCopy } from '@douyinfe/semi-icons';
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

const buildMergedContent = (content) => {
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

const TabContent = ({ content, defaultMerged, t }) => {
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
    setDisplayContent(content || '');
  }, [content, defaultMerged]);

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
            <TabContent content={detail.downstream_request} t={t} />
          </TabPane>
          <TabPane tab={t('上游请求')} itemKey='upstream_request'>
            <TabContent content={detail.upstream_request} t={t} />
          </TabPane>
          <TabPane tab={t('上游响应')} itemKey='upstream_response'>
            <TabContent content={detail.upstream_response} defaultMerged t={t} />
          </TabPane>
          <TabPane tab={t('下游响应')} itemKey='downstream_response'>
            <TabContent content={detail.downstream_response} defaultMerged t={t} />
          </TabPane>
        </Tabs>
      ) : (
        <Empty description={t('暂无数据')} />
      )}
    </Modal>
  );
};

export default LogDetailModal;
