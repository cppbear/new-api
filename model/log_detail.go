package model

import (
	"github.com/QuantumNous/new-api/common"
)

const maxLogContentSize = 64 * 1024 // 64KB

type LogDetail struct {
	Id                 int    `json:"id" gorm:"primaryKey;autoIncrement"`
	LogId              int    `json:"log_id" gorm:"uniqueIndex:idx_log_details_log_id"`
	DownstreamRequest  string `json:"downstream_request" gorm:"type:text"`
	UpstreamRequest    string `json:"upstream_request" gorm:"type:text"`
	UpstreamResponse   string `json:"upstream_response" gorm:"type:text"`
	DownstreamResponse string `json:"downstream_response" gorm:"type:text"`
	CreatedAt          int64  `json:"created_at" gorm:"bigint"`
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func CreateLogDetail(detail *LogDetail) error {
	detail.DownstreamRequest = truncateString(detail.DownstreamRequest, maxLogContentSize)
	detail.UpstreamRequest = truncateString(detail.UpstreamRequest, maxLogContentSize)
	detail.UpstreamResponse = truncateString(detail.UpstreamResponse, maxLogContentSize)
	detail.DownstreamResponse = truncateString(detail.DownstreamResponse, maxLogContentSize)
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
