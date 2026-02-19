package middleware

import (
	"bytes"
	"io"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
)

const maxLogCaptureSize = 64 * 1024 // 64KB

// logContentResponseWriter wraps gin.ResponseWriter to capture response bytes.
type logContentResponseWriter struct {
	gin.ResponseWriter
	buf *bytes.Buffer
}

func (w *logContentResponseWriter) Write(data []byte) (int, error) {
	remaining := maxLogCaptureSize - w.buf.Len()
	if remaining > 0 {
		if len(data) > remaining {
			w.buf.Write(data[:remaining])
		} else {
			w.buf.Write(data)
		}
	}
	return w.ResponseWriter.Write(data)
}

// LogContentCapture captures downstream request/response and collects upstream
// request/response from context, then asynchronously creates a LogDetail record.
func LogContentCapture() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !common.LogContentEnabled {
			c.Next()
			return
		}

		// 1. Capture downstream request body from BodyStorage
		var downstreamReq string
		storage, err := common.GetBodyStorage(c)
		if err == nil {
			if bodyBytes, bErr := storage.Bytes(); bErr == nil {
				if len(bodyBytes) > maxLogCaptureSize {
					downstreamReq = string(bodyBytes[:maxLogCaptureSize])
				} else {
					downstreamReq = string(bodyBytes)
				}
			}
			// Reset storage position for downstream handlers
			storage.Seek(0, io.SeekStart)
		}

		// 2. Wrap response writer to capture downstream response
		buf := &bytes.Buffer{}
		writer := &logContentResponseWriter{
			ResponseWriter: c.Writer,
			buf:            buf,
		}
		c.Writer = writer

		// 3. Process request
		c.Next()

		// 4. Collect data and create LogDetail asynchronously
		logId, exists := c.Get("log_record_id")
		if !exists {
			return
		}
		logIdInt, ok := logId.(int)
		if !ok || logIdInt == 0 {
			return
		}

		upstreamReq, _ := c.Get("log_upstream_request")
		upstreamResp, _ := c.Get("log_upstream_response")

		upstreamReqStr, _ := upstreamReq.(string)
		upstreamRespStr, _ := upstreamResp.(string)
		downstreamRespStr := buf.String()

		gopool.Go(func() {
			detail := &model.LogDetail{
				LogId:              logIdInt,
				DownstreamRequest:  downstreamReq,
				UpstreamRequest:    upstreamReqStr,
				UpstreamResponse:   upstreamRespStr,
				DownstreamResponse: downstreamRespStr,
			}
			if err := model.CreateLogDetail(detail); err != nil {
				common.SysLog("failed to create log detail: " + err.Error())
			}
		})
	}
}
