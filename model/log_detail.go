package model

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

const maxLogContentSize = 1024 * 1024 // 1MB

type LogDetail struct {
	Id                       int    `json:"id" gorm:"primaryKey;autoIncrement"`
	LogId                    int    `json:"log_id" gorm:"uniqueIndex:idx_log_details_log_id"`
	DownstreamRequest        string `json:"downstream_request" gorm:"type:text"`
	UpstreamRequest          string `json:"upstream_request" gorm:"type:text"`
	UpstreamResponse         string `json:"upstream_response" gorm:"type:text"`
	DownstreamResponse       string `json:"downstream_response" gorm:"type:text"`
	DownstreamRequestHeader  string `json:"downstream_request_header" gorm:"type:text"`
	UpstreamRequestHeader    string `json:"upstream_request_header" gorm:"type:text"`
	UpstreamResponseHeader   string `json:"upstream_response_header" gorm:"type:text"`
	DownstreamResponseHeader string `json:"downstream_response_header" gorm:"type:text"`
	CreatedAt                int64  `json:"created_at" gorm:"bigint"`
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	// Back up to a valid UTF-8 boundary
	truncated := s[:maxLen]
	for len(truncated) > 0 && !utf8.RuneStart(truncated[len(truncated)-1]) {
		truncated = truncated[:len(truncated)-1]
	}
	// Drop the incomplete leading byte if present
	if len(truncated) > 0 && truncated[len(truncated)-1] >= 0xC0 {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}

var sensitiveHeaderKeys = map[string]bool{
	"authorization": true,
	"api-key":       true,
	"x-api-key":     true,
	"x-goog-api-key": true,
}

func sanitizeHeaders(h http.Header) http.Header {
	if operation_setting.SelfUseModeEnabled {
		return h
	}
	sanitized := make(http.Header, len(h))
	for k, vals := range h {
		if sensitiveHeaderKeys[strings.ToLower(k)] {
			masked := make([]string, len(vals))
			for i, v := range vals {
				if len(v) > 8 {
					masked[i] = v[:8] + "***"
				} else {
					masked[i] = "***"
				}
			}
			sanitized[k] = masked
		} else {
			sanitized[k] = vals
		}
	}
	return sanitized
}

func HeadersToJSON(h http.Header) string {
	if h == nil {
		return ""
	}
	sanitized := sanitizeHeaders(h)
	// Flatten single-value headers to plain strings
	flat := make(map[string]interface{}, len(sanitized))
	for k, vals := range sanitized {
		if len(vals) == 1 {
			flat[k] = vals[0]
		} else {
			flat[k] = vals
		}
	}
	data, err := common.Marshal(flat)
	if err != nil {
		return ""
	}
	return truncateString(string(data), maxLogContentSize)
}

func CreateLogDetail(detail *LogDetail) error {
	// Sanitize non-UTF-8 bytes before truncation to prevent DB insert failures
	detail.DownstreamRequest = strings.ToValidUTF8(detail.DownstreamRequest, "\uFFFD")
	detail.UpstreamRequest = strings.ToValidUTF8(detail.UpstreamRequest, "\uFFFD")
	detail.UpstreamResponse = strings.ToValidUTF8(detail.UpstreamResponse, "\uFFFD")
	detail.DownstreamResponse = strings.ToValidUTF8(detail.DownstreamResponse, "\uFFFD")
	detail.DownstreamRequest = truncateString(detail.DownstreamRequest, maxLogContentSize)
	detail.UpstreamRequest = truncateString(detail.UpstreamRequest, maxLogContentSize)
	detail.UpstreamResponse = truncateString(detail.UpstreamResponse, maxLogContentSize)
	detail.DownstreamResponse = truncateString(detail.DownstreamResponse, maxLogContentSize)
	detail.DownstreamRequestHeader = truncateString(detail.DownstreamRequestHeader, maxLogContentSize)
	detail.UpstreamRequestHeader = truncateString(detail.UpstreamRequestHeader, maxLogContentSize)
	detail.UpstreamResponseHeader = truncateString(detail.UpstreamResponseHeader, maxLogContentSize)
	detail.DownstreamResponseHeader = truncateString(detail.DownstreamResponseHeader, maxLogContentSize)
	detail.CreatedAt = common.GetTimestamp()
	return LOG_DB.Create(detail).Error
}

func GetLogDetailByLogId(logId int) (*LogDetail, error) {
	var detail LogDetail
	err := LOG_DB.Where("log_id = ?", logId).First(&detail).Error
	if err != nil {
		return nil, err
	}
	return &detail, nil
}

func DeleteLogDetailsByTimestamp(targetTimestamp int64, limit int) (int64, error) {
	// Delete log_details whose log_id references logs older than targetTimestamp
	result := LOG_DB.Where("log_id IN (SELECT id FROM logs WHERE created_at < ?)", targetTimestamp).Limit(limit).Delete(&LogDetail{})
	return result.RowsAffected, result.Error
}
