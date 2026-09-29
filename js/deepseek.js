(function (global) {
  'use strict';

  var API_URL = 'https://api.deepseek.com/chat/completions';
  var MODEL = 'deepseek-chat';

  function clean(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  function toNum(v, fallback) {
    if (v == null || String(v).trim() === '') return fallback;
    var n = Number(String(v).replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? Math.round(n) : fallback;
  }

  function toMinute(v, fallback) {
    if (v == null || String(v).trim() === '') return fallback;
    var s = String(v).trim().replace(/[：]/g, ':');
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return toNum(s, fallback);
  }

  function invalid(message) {
    var err = new Error(message);
    err.repair = true;
    return err;
  }

  function inputPayload(input) {
    return {
      defaultStartTime: input.defaultStartTime,
      defaultStartMin: input.defaultStartMin,
      stopMinutes: input.stopMinutes,
      roundTrip: !!input.roundTrip,
      start: input.start,
      end: input.end,
      vehicles: input.vehicles.map(function (v) {
        return {
          id: v.id,
          plateNo: v.plateNo || '',
          driverName: v.driverName || '',
          color: v.color || ''
        };
      }),
      tasks: input.tasks.map(function (t) {
        return {
          id: t.id,
          shopName: t.shopName || '',
          address: t.address || '',
          lng: t.lng,
          lat: t.lat,
          deadline: t.deadline || '',
          deadlineMin: t.deadlineMin == null ? null : t.deadlineMin
        };
      })
    };
  }

  function buildMessages(input, repairError) {
    var system = [
      '你是上海地区专业配送调度员，负责把任务分给车辆并排访问顺序。',
      '只能输出一个 JSON 对象，不要输出 Markdown、解释、时间或里程估算。',
      '',
      '硬性规则：',
      '1. 必须使用全部车辆，每辆车至少分配一个任务。',
      '2. 每个任务必须且只能出现在一辆车上。',
      '3. 尽量让每辆车任务数接近平均（总任务数 / 车辆数），不要让某辆车拿到特别多任务。',
      '4. 按区域就近分车：同一片区的任务尽量放同一辆车，避免一辆车南北大跨度乱跑。',
      '5. 有截止时间的任务要优先安排，顺序尽量在截止时间前到。',
      '6. taskId 和 vehicleId 必须原样使用输入中的值，每辆车的任务按建议访问顺序填写。',
      '',
      '只返回这个 JSON 结构：',
      '{"routes":[{"vehicleId":"v1","stops":[{"taskId":"t1","order":1},{"taskId":"t2","order":2}]}]}',
      '不需要输出 startMin、finishMin、etaMin、distanceM、driveMin 等时间里程字段，程序会按实际路线重新计算。'
    ].join('\n');
    var user = '请按规则排车，输入数据如下：\n' + JSON.stringify(inputPayload(input));
    if (repairError) {
      user += '\n\n上一次输出不合格：' + repairError + '。请修正后重新输出完整 JSON。';
    }
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  function request(key, messages) {
    return fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: messages
      })
    }).then(function (resp) {
      return resp.text().then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw invalid('DeepSeek 返回内容不是有效 JSON');
        }
        if (!resp.ok) {
          var msg = data && data.error && data.error.message;
          throw new Error(msg || ('DeepSeek 接口错误：' + resp.status));
        }
        var content = data && data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content;
        if (!content) throw invalid('DeepSeek 没有返回排车方案');
        return content;
      });
    }, function () {
      throw new Error('DeepSeek 接口请求失败，请检查网络或 Key');
    });
  }

  function parseContent(content) {
    var text = String(content || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw invalid('AI 返回的方案 JSON 无法解析');
    }
  }

  function mapVehicles(vehicles) {
    var map = {};
    vehicles.forEach(function (v) {
      [v.id, v.plateNo, v.driverName, v.label].forEach(function (key) {
        key = clean(key);
        if (key) map[key] = v;
      });
    });
    return map;
  }

  function normalize(raw, input) {
    var plan = raw && raw.plan ? raw.plan : raw;
    var routes = plan && plan.routes;
    if (!Array.isArray(routes) || !routes.length) throw invalid('AI 没有返回 routes');

    var vehicleByKey = mapVehicles(input.vehicles);
    var taskById = {};
    input.tasks.forEach(function (t) { taskById[t.id] = t; });
    var usedVehicle = {};
    var usedTask = {};
    var out = [];

    routes.forEach(function (r) {
      r = r || {};
      var vehicle = vehicleByKey[clean(r.vehicleId)] ||
        vehicleByKey[clean(r.vehicle_id)] ||
        vehicleByKey[clean(r.plateNo)] ||
        vehicleByKey[clean(r.plate)];
      if (!vehicle) throw invalid('AI 返回了未知车辆：' + clean(r.vehicleId));
      if (usedVehicle[vehicle.id]) throw invalid('AI 重复分配车辆：' + vehicle.id);
      usedVehicle[vehicle.id] = true;

      var rawStops = r.stops || r.tasks || r.orders;
      if (!Array.isArray(rawStops) || !rawStops.length) {
        throw invalid('车辆 ' + vehicle.id + ' 没有任务');
      }
      var stops = rawStops.map(function (s, index) {
        s = s || {};
        var taskId = clean(s.taskId || s.task_id || s.id);
        var task = taskById[taskId];
        if (!task) throw invalid('AI 返回了未知任务：' + taskId);
        if (usedTask[taskId]) throw invalid('AI 重复分配任务：' + taskId);
        usedTask[taskId] = true;
        return { raw: s, task: task, index: index };
      }).sort(function (a, b) {
        var ao = toNum(a.raw.order, a.index + 1);
        var bo = toNum(b.raw.order, b.index + 1);
        return ao - bo;
      });

      var prevDepart = toMinute(r.startMin, input.defaultStartMin);
      var normalizedStops = [];
      var totalDistanceM = 0;
      var totalDriveMin = 0;
      stops.forEach(function (item, index) {
        var s = item.raw;
        var task = item.task;
        var driveMin = Math.max(0, toNum(s.driveMin, 0));
        var distanceM = Math.max(0, toNum(s.distanceM, 0));
        var etaMin = toMinute(s.etaMin, prevDepart + driveMin);
        var departMin = toMinute(s.departMin, etaMin + input.stopMinutes);
        var hasEta = s.etaMin != null && String(s.etaMin).trim() !== '';
        if (hasEta && task.deadlineMin != null && etaMin > task.deadlineMin) {
          throw invalid('任务 ' + task.id + ' 超过截止时间');
        }
        if (s.conflict === true) {
          throw invalid('任务 ' + task.id + ' 被 AI 标记为超时冲突');
        }
        totalDistanceM += distanceM;
        totalDriveMin += driveMin;
        normalizedStops.push({
          taskId: task.id,
          order: index + 1,
          etaMin: etaMin,
          departMin: departMin,
          conflict: false,
          distanceM: distanceM,
          driveMin: driveMin
        });
        prevDepart = departMin;
      });

      var startMin = toMinute(r.startMin, input.defaultStartMin);
      var last = normalizedStops[normalizedStops.length - 1];
      var finishMin = toMinute(r.finishMin, (last ? last.departMin : startMin) + Math.max(0, toNum(r.returnDriveMin, 0)));
      out.push({
        vehicleId: vehicle.id,
        label: vehicle.label || ('车 ' + (out.length + 1)),
        plateNo: vehicle.plateNo || '',
        driverName: vehicle.driverName || '',
        driverPhone: vehicle.driverPhone || '',
        color: vehicle.color || '#2563EB',
        stops: normalizedStops,
        startMin: startMin,
        finishMin: finishMin,
        totalDistanceM: Math.max(0, toNum(r.totalDistanceM, totalDistanceM)),
        totalDurationMin: Math.max(0, toNum(r.totalDurationMin, finishMin - startMin)),
        conflictCount: 0,
        legs: [],
        waypoints: []
      });
    });

    input.vehicles.forEach(function (v) {
      if (!usedVehicle[v.id]) throw invalid('AI 没有使用车辆：' + v.id);
    });
    input.tasks.forEach(function (t) {
      if (!usedTask[t.id]) throw invalid('AI 漏掉任务：' + t.id);
    });

    if (out.length !== input.vehicles.length) {
      throw invalid('AI 返回的车辆数量不正确');
    }
    return { routes: out };
  }

  function plan(input) {
    var key = clean(input && input.apiKey);
    if (!key) {
      var missing = new Error('请先在设置里填写 DeepSeek API Key');
      missing.repair = false;
      return Promise.reject(missing);
    }
    var messages = buildMessages(input);
    return request(key, messages).then(parseContent).then(function (raw) {
      return normalize(raw, input);
    }).catch(function (err) {
      if (!err || !err.repair) throw err;
      var retryMessages = buildMessages(input, err.message);
      return request(key, retryMessages).then(parseContent).then(function (raw) {
        return normalize(raw, input);
      });
    });
  }

  global.DeepSeekPlanner = {
    plan: plan,
    model: MODEL
  };
})(window);
