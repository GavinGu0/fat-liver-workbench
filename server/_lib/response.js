'use strict';
const { randomUUID } = require('node:crypto');

function makeReqId() {
  return 'req_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function ok(res, data, requestId) {
  res.status(200).json({ code: 0, message: 'ok', data: data ?? null, requestId });
}

function fail(res, httpStatus, bizCode, message, requestId) {
  res.status(httpStatus).json({ code: bizCode, message, data: null, requestId });
}

/** 业务错误：统一抛出，由 handler 兜底捕获 */
class ApiError extends Error {
  constructor(httpStatus, bizCode, message) {
    super(message);
    this.httpStatus = httpStatus;
    this.bizCode = bizCode;
  }
}

module.exports = { makeReqId, ok, fail, ApiError };
