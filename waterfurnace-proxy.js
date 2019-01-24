const winston = require('winston')

const querystring = require('querystring')
const request = require('request')
const cookie = require('cookie')
const WebSocket = require('ws')
const fs = require('fs')
const config = JSON.parse(fs.readFileSync('config.json'))
const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console()
  ]
})

const express = require('express')
const bodyParser = require('body-parser')
const app = express()
const server = require('http').Server(app)
const port = config.serverPort
const helmet = require('helmet')

var lastResponse = {}
var websocketPostMessage = {}
var tid = 1
var awlid = ''

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // Temporary hold over since the WF cert expired

/*
const modeEnum = {
  OFF: 0,
  AUTO: 1,
  COOL: 2,
  HEAT: 3,
  EHEAT: 4
}

const fanEnum = {
  AUTO: 0,
  CONTINUOUS: 1,
  INTERMITTENT: 2
}
*/

function isEmptyObject (obj) {
  return !Object.keys(obj).length
}

function getLoginSession (callback) {
  var formData = querystring.stringify({
    op: 'login',
    redirect: '/',
    emailaddress: config.emailAddress,
    password: config.password
  })
  request({
    headers: {
      'Content-Length': formData.length,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': 'legal-acknowledge=yes'
    },
    followAllRedirects: true,
    uri: 'https://symphony.mywaterfurnace.com/',
    body: formData,
    method: 'POST'
  }, function (err, res, body) {
    if (!err && res.statusCode === 200) {
      return callback(null, res)
    } else {
      return callback(err)
    }
  })
};

app.use(helmet())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept')
  next()
})

app.options('*', function (req, res) {
  res.send(200)
})

app.get('/', function (req, res) {
  if (!isEmptyObject(req.query)) {
    websocketPostMessage = {
      'cmd': 'write',
      'tid': tid,
      'awlid': awlid,
      'source': 'tstat'
    }
    // Heating and cooling set points
    if (req.query.heatingsp_write) { websocketPostMessage.heatingsp_write = req.query.heatingsp_write }
    if (req.query.coolingsp_write) { websocketPostMessage.coolingsp_write = req.query.coolingsp_write }
    // Operation mode
    if (req.query.activemode_write) { websocketPostMessage.activemode_write = req.query.activemode_write }
    // Fan controls
    if (req.query.fanmode_write) { websocketPostMessage.fanmode_write = req.query.fanmode_write }
    if (req.query.intertimeon_write) { websocketPostMessage.intertimeon_write = req.query.intertimeon_write }
    if (req.query.intertimeoff_write) { websocketPostMessage.intertimeoff_write = req.query.intertimeoff_write }
    // Humidification and dehumidification controls
    if (req.query.humidity_offset) { websocketPostMessage.humidity_offset_settings.humidity_offset = req.query.humidity_offset }
    if (req.query.humdity_control_option) { websocketPostMessage.humidity_offset_settings.humdity_control_option = req.query.humdity_control_option }
    if (req.query.humidification_mode) { websocketPostMessage.humidity_offset_settings.humidification_mode = req.query.humidification_mode }
    if (req.query.dehumidification_mode) { websocketPostMessage.humidity_offset_settings.dehumidification_mode = req.query.dehumidification_mode }
    if (req.query.dehumidification) { websocketPostMessage.dehumid_humid_sp.dehumidification = req.query.dehumidification }
    if (req.query.humidification) { websocketPostMessage.dehumid_humid_sp.humidification = req.query.humidification }

    if (Object.keys(websocketPostMessage).length <= 4) {
      logger.debug('Ambiguous query parameters')
      websocketPostMessage = {}
    }
  }

  res.status(200)
  res.json(JSON.parse(lastResponse))
  res.end()
})

function getLoginRequest (sessionid) {
  return {
    'cmd': 'login',
    'tid': 1,
    'source': 'consumer dashboard',
    'sessionid': sessionid
  }
}

function getReadRequest (tid, awlid) {
  return {
    'cmd': 'read',
    'tid': tid,
    'awlid': awlid,
    'zone': 0,
    'rlist': [
      'compressorpower',
      'fanpower',
      'auxpower',
      'looppumppower',
      'totalunitpower',
      'AWLABCType',
      'ModeOfOperation',
      'ActualCompressorSpeed',
      'AirflowCurrentSpeed',
      'AuroraOutputEH1',
      'AuroraOutputEH2',
      'AuroraOutputCC',
      'AuroraOutputCC2',
      'TStatDehumidSetpoint',
      'TStatRelativeHumidity',
      'LeavingAirTemp',
      'TStatRoomTemp',
      'EnteringWaterTemp',
      'AOCEnteringWaterTemp',
      'LeavingWaterTemp',
      'auroraoutputrv',
      'AWLTStatType',
      'humidity_offset_settings',
      'iz2_humidity_offset_settings',
      'dehumid_humid_sp',
      'iz2_dehumid_humid_sp',
      'lockoutstatus',
      'lastfault',
      'lastlockout',
      'homeautomationalarm1',
      'homeautomationalarm2',
      'roomtemp',
      'activesettings',
      'TStatActiveSetpoint',
      'TStatMode',
      'TStatHeatingSetpoint',
      'TStatCoolingSetpoint'
    ],
    'source': 'consumer dashboard'
  }
}

getLoginSession(function (err, res) {
  if (!err) {
    var cookies = cookie.parse(res.headers['set-cookie'][0])
    var sessionid = cookies.sessionid
    var loginMessage = {}

    var connection = new WebSocket('wss://awlclientproxy.mywaterfurnace.com/', {
      origin: 'https://symphony.mywaterfurnace.com'
    })

    connection.on('open', function open () {
      logger.verbose('websocket connected')
      connection.send(JSON.stringify(getLoginRequest(sessionid)))
    })

    connection.on('close', function close () {
      logger.verbose('websocket disconnected')
    })

    connection.on('message', function incoming (data) {
      logger.verbose('websocket message data: ' + data)
      var dataJson = JSON.parse(data)

      if (dataJson.rsp && dataJson.rsp === 'login') {
        awlid = dataJson.locations[0].gateways[0].gwid
        server.listen(port, (err) => {
          if (err) {
            throw err
          }
          logger.info('Express is listening on ' + port)
        })
      } else if (dataJson.err === 'Missing transaction.') {
        logger.debug('Renewing sessionid')
        getLoginSession(function (err, res) {
          if (!err) {
            cookies = cookie.parse(res.headers['set-cookie'][0])
            sessionid = cookies.sessionid
            tid = 1
            loginMessage = getLoginRequest(sessionid)
          } else {
            logger.error(err)
            process.exit()
          }
        })
      } else {
        lastResponse = data
      }

      setTimeout(function timeout () {
        var requestMessage = ''

        if (!isEmptyObject(loginMessage !== '')) {
          requestMessage = loginMessage
        } else if (!isEmptyObject(websocketPostMessage)) {
          requestMessage = websocketPostMessage
          websocketPostMessage = {}
        } else {
          requestMessage = getReadRequest(tid, awlid)
        }

        logger.debug('req: ' + JSON.stringify(requestMessage))
        connection.send(JSON.stringify(requestMessage))
        tid++
      }, config.pollingTime * 1000)
    })
  } else {
    logger.error(err)
    process.exit()
  }
})