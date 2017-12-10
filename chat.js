#!/usr/bin / env node

const puppeteer = require('puppeteer');
const notifier = require('node-notifier');
const winston = require('winston');
const fs = require('fs');

const config = require('./config.js');
const selector = require('./selector.js');

// get user from command line argument
let user = process.argv[2];

// make sure they specified user to chat with
if (!user) {
  console.log('User argument not specified, exiting...');
  process.exit(1);
}

process.setMaxListeners(0);

(async function main() {

  const logger = setUpLogging();

  try {

    // custom vars ///////////////////////////////
    let last_received_message = '';
    let last_sent_message_interval = null;
    let last_new_message_interval = null;
    let sentMessages = [];
    let newMessages = [];
    //////////////////////////////////////////////    

    const timeout = 3000000;
    const networkIdleTimeout = 10000;
    const stdin = process.stdin;
    const stdout = process.stdout;
    const headless = !config.window;

    const browser = await puppeteer.launch({
      headless: headless,
      userDataDir: config.data_dir,
      timeout: timeout,
      networkIdleTimeout: networkIdleTimeout,
      args: ['--disable-infobars']
    });

    const page = await browser.newPage();

    // set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36');

    print('Loading...', 'info');
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'networkidle2' });

    //await page.waitFor(30000); // doesn't always work

    startChat(user);

    readCommands();

    // allow user to type on console and read it
    function readCommands() {
      stdin.resume();
      stdin.on('data', function (data) {
        let message = data.toString().trim();

        // check for command "--chat UserName" to start new chat with that user
        if (message.toLowerCase().indexOf('--chat') > -1) {
          let new_user = message.split(" ")[1];

          if (new_user) {
            startChat(new_user);
            user = new_user;
          }
        }
        else {
          typeMessage(message);
        }

        stdin.resume();
      });
    }

    // start chat with specified user
    async function startChat(user) {
      // replace selector with selected user
      let user_chat_selector = selector.user_chat;
      user_chat_selector = user_chat_selector.replace('XXX', user);

      await page.waitFor(user_chat_selector);

      let name = getCurrentUserName();

      if (name) {
        await page.click(user_chat_selector);
        await page.click(selector.chat_input);

        print('You can chat now :-)', 'header');
        print('Press Ctrl+C twice to exit any time.', 'error');
      }
      else {
        print('Could not find specified user "' + user + '"in chat threads', 'error');
      }
    }

    // type user-supplied message into chat window for selected user
    async function typeMessage(message) {
      await page.keyboard.type(message);
      await page.keyboard.press('Enter');

      // verify message is sent
      let messageSent = await page.evaluate((selector) => {

        let nodes = document.querySelectorAll(selector);
        let el = nodes[nodes.length - 1];

        return el ? el.innerText : '';
      }, selector.last_message_sent);

      if (message == messageSent) {
        print("You: " + message, 'warning');

        // setup interval for read receipts
        if (config.read_receipts) {
          last_sent_message_interval = setInterval(function () {
            isLastMessageRead(user, message);
          }, (config.check_message_interval * 1000));
        }

      }

      // see if they sent a new message
      readLastOtherPersonMessage();
    }

    // read user's name from conversation thread
    async function getCurrentUserName() {
      return await page.evaluate((selector) => {
        let el = document.querySelector(selector);

        return el ? el.innerText : '';
      }, selector.user_name);
    }

    // read any new messages sent by specified user
    async function readLastOtherPersonMessage() {

      let name = await getCurrentUserName();

      if (!name) {
        name = user;
      }

      // read last message sent by other user
      let message = await page.evaluate((selector) => {

        let nodes = document.querySelectorAll(selector);
        let el = nodes[nodes.length - 1];

        return el ? el.innerText : '';
      }, selector.last_message);

      if (message) {
        if (last_received_message) {
          if (last_received_message != message) {
            last_received_message = message;
            print(name + ": " + message, 'success');

            // show notification
            if (config.notification_enabled) {

              let notifContent = message;
              let notifName = name;

              if (config.notification_hide_message) {
                notifContent = config.notification_hidden_message || 'New Message Received';
              }

              if (config.notification_hide_user) {
                notifName = config.notification_hidden_user || 'Someone';
              }

              notifier.notify({
                title: notifName,
                message: notifContent,
                wait: false,
                sound: config.notification_sound,
                timeout: config.notification_time
              });

            }
          }
        }
        else {
          last_received_message = message;
          print(name + ": " + message, 'success');
        }

      }
    }

    // checks if last message sent is read
    async function isLastMessageRead(name, message) {

      let is_last_message_read = await page.evaluate((selector) => {

        let nodes = document.querySelectorAll(selector);
        let el = nodes[nodes.length - 1];

        if (el) {
          let readHTML = el.innerHTML;

          if (readHTML.length) {
            return readHTML.indexOf('data-icon="msg-dblcheck-ack"') > -1;
          }
        }

        return false;
      }, selector.last_message_read);

      if (is_last_message_read) {
        if (config.read_receipts && last_sent_message_interval) {
          let msg = 'READ: "' + message + '"';

          // make sure we don't report for same message again
          if (!sentMessages.includes(msg)) {
            print(msg, 'info');

            sentMessages.push(msg);

            clearInterval(last_sent_message_interval);
          }
        }
      }

    }

    // checks for any new messages sent by all other users
    async function checkNewMessagesAllUsers() {
      // todo
    }

    // prints on console
    function print(message, type = null) {

      if (!config.colors) {
        console.log('\n' + message);
        return;
      }

      let end_color = '\033[0m';

      let types = {
        header: '\033[95m',
        info: '\033[94m',
        success: '\033[92m',
        warning: '\033[93m',
        error: '\033[91m',
        bold: '\033[1m'
      };

      if (type == null) {
        console.log('\n' + message);
      }
      else {
        console.log('\n' + types[type] + message + end_color);
      }

    }

    setInterval(readLastOtherPersonMessage, (config.check_message_interval * 1000))

    //await browser.close();

  } catch (err) {
    //console.error(err);
    logger.warn(err);
  }

  // setup logging
  function setUpLogging() {

    const env = process.env.NODE_ENV || 'development';
    const logDir = 'logs';

    // Create the log directory if it does not exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir);
    }

    const tsFormat = () => (new Date()).toLocaleTimeString();

    const logger = new (winston.Logger)({
      transports: [
        // colorize the output to the console
        new (winston.transports.Console)({
          timestamp: tsFormat,
          colorize: true,
          level: 'info'
        }),
        new (winston.transports.File)({
          filename: `${logDir}/log.log`,
          timestamp: tsFormat,
          level: env === 'development' ? 'debug' : 'info'
        })
      ]
    });

    return logger;
  }

})();

