require("dotenv").config();
const qs = require("querystring");
const getConfig = require("./config");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const numeral = require("numeral");
var colors = require("colors");
const axiosRetry = require("axios-retry");
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const uuid = require("uuid");
const excludedAttack = [
  "rof4__cjzn7tig40149hdli9tzz8f7g",
  "rof4__cjzgkbk3s02cib3k76fci3yw6",
  "rof4__ck09czjio03i2aulcfp5d1653",
  "rof4__cjzq2ta7s01qgasl87kg5dmro"
];
// axiosRetry(axios, {
//   retries: 3
// })
axios.interceptors.response.use(null, error => {
  if (error.config && error.response && error.response.status === 502) {
    console.log("axios retry due to 502 response");
    console.log("url", error.config.url);
    return axios.request(error.config);
  }

  return Promise.reject(error);
});

class CoinMaster {
  /**
   *
   * @param {*} options
   * @example
   * {
   *  dumpResponseToFile: true,
   *  userId: "xxx",
   *  fbToken: "xxx",
   *  deviceId: "deviceId"
   *  onData : function(resonse) {},
   *  upgradeInterval : 10
   * }
   */
  constructor(options) {
    this.options = options || {};
    this.dumpResponseToFile = options.dumpResponseToFile || true;
    this.lastNoCoinIndex = -1;
    this.userId = options.userId || process.env.USER_ID;
    this.fbToken = options.fbToken || process.env.FB_TOKEN;
    this.sleep = options.sleep || process.env.SLEEP;
    this.verbose = options.verbose || process.env.VERBOSE === "true";
    this.bet = options.bet || process.env.BET || 1;
    this.fbUserToken = options.fbUserToken || process.env.FB_USER_TOKEN;
    this.upgradeInterval =
      options.upgradeInterval ||
      parseInt(process.env.UPGRADE_INTERVAL || "10", 10);
    this.enableTracking =
      options.enableTracking || process.env.TRACKING_EVENT === true;
    this.deviceId = options.deviceId || process.env.DEVICE_ID;
    this.deviceChange = options.deviceChange || process.env.DEVICE_CHANGE;
    this.config = getConfig(this.deviceId, this.deviceChange, this.fbToken);
    this.attackPrefer = options.attackPrefer || process.env.ATTACK_PREFER;
    this.attackTarget = options.attackTarget || process.env.ATTACK_TARGET || "";
    this.attackRaidGap = options.attackRaidGap || parseInt(process.env.ATTACK_RAID_GAP || "5", 10),
    this.onData = options.onData || function() {};
    this.spinCountFromAttack = 0;
    this.spinCountFromRaid = 0;
    this.priorityUpgrade = options.priorityUpgrade || process.env.PRIORITY_UPGRADE;
    this.enemyId = options.enemyId || process.env.ENEMY_ID;
    this.raidBetSwitch =
      this.options.raidBetSwitch ||
      parseInt(process.env.RAID_BET_SWITCH || "30", 10);
    this.attackBetSwitch =
      this.options.attackBetSwitch ||
      parseInt(process.env.ATTACK_BET_SWITCH || "16", 10);
    this.autoBet =
      this.options.autoBet || process.env.AUTO_BET === "true" || true;
    this.maxAutoBet = this.config.maxAutoBet || parseInt(process.env.MAX_AUTO_BET || "3", 10);
    this.raidBetMinLimit =
      this.options.raidBetMinLimit ||
      parseInt(process.env.RAID_BET_MIN_LIMIT || "25000000", 10);
    this.attackCountFromRaid = 0;
    this.shieldCountFromAttack=0;
    console.log("Auto switcher at", this.raidBetSwitch, this.attackBetSwitch);
    console.log("Enemy target", this.attackTarget);
    this.axiosConfig = {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };
    this.dataFile = path.join(__dirname, "data", this.userId + ".csv");
    this.spinResult = null;
    this.upgradeCost = {};
    
  }
  async readHistoryData() {
    return new Promise(resolve => {
      if (!fs.existsSync(this.dataFile)) {
        fs.writeFileSync(this.dataFile, "r1,r2,r3,type\n");
      }
      const data = [];
      fs.createReadStream(this.dataFile)
        .pipe(csv())
        .on("data", row => {
          data.push(row);
        })
        .on("end", () => {
          resolve(data);
        });
    });
  }
  async updateHistoryData(r1, r2, r3, type, spinCount) {
    if (!this.csvStream) {
      this.csvStream = fs.createWriteStream(this.dataFile, { flags: "a" });
    }
    this.csvStream.write(`${r1},${r2},${r3},${type},${spinCount}\n`);
  }
  dumpFile(name, response) {
    name = name || "response";
    if (this.dumpResponseToFile) {
      fs.writeJsonSync(path.join(__dirname, "data", name + ".json"), response, {
        spaces: 4
      });
    }
  }
  async getFriend(friendId) {
    const info = await this.post(`friends/${friendId}`);
    info.id = friendId;
    info.village = {
      ...info
    };
    // console.log(`FRIEND: ${friendId}`, info.name);
    return info;
  }
  async fetchMetadata() {
    const response = await axios.get(
      "https://static.moonactive.net/data/vikings/production-3_5_fbweb_Pool-all.json"
    );
    // console.log("metadata", response.data.data.profile);
    this.profile = response.data.data.profile;
    this.config["Device[change]"] = response.data.data.profile.change_purpose;
    // console.log("config", this.config);
    // throw new Error("tata");
  }
  async getAllMessages() {
    //console.log("********************Spins*******************".green);
    const info = await this.post(`all_messages`);
    await this.handleMessage(info);
    //console.log(`All Message:`, info.messages.length);
    return info;
  }
  async daillySpin() {
    const result = await this.post("dailybonus/collect", {
      segmented: true,
      extra: false
    });
    console.log("Daily spin : ", result.reward);
  }
  async post(url, data, retry) {
    if (url.indexOf("http") === -1) {
      url = `https://vik-game.moonactive.net/api/v1/users/${this.userId}/${url}`;
    }
    data = data || {};
    retry = retry || 0;
    const formData = {
      ...this.config,
      ...data
    };
    try {
      if (this.verbose) {
        console.log(colors.dim(`#${retry + 1} Request Url : ${url}`), data);
        console.log("Form data", qs.stringify(formData));
      }
      const response = await axios.post(
        url,
        qs.stringify(formData),
        this.axiosConfig
      );
      const info = response.data;
      
      return info;
    } catch (err) {
      console.log("Error".red, err.response.status, err.response.statusText);
      // if (retry < 3) {
      // return this.post(url, data, retry + 1);
      //}
    }
    return null;
  }
  async getDailyFreeRewards() {
    const sss = 
    await this.post("https://vik-game.moonactive.net/external/facebook/CoinMaster_3.5.33_prod_225/connect?minScreenSize=1300&pid=FB_PAGE&c=%28_%29VKpenjlwl00SkioYg0ZC6zw_382EWrI3LoCnT7qirDQ&campaign=%28_%29VKpenjlwl00SkioYg0ZC6zw_382EWrI3LoCnT7qirDQ&af_deeplink=true");
    console.log(sss);
    const campaign = "(_)VKpenjlwl00SkioYg0ZC6zw_382EWrI3LoCnT7qirDQ";
    const response = await this.post(`campaigns/${campaign}/click`);
    console.log(response);
  }
  numberFormat(num) {
    return numeral(num).format("$(0.000a)")
   
  }
  async spin(lastRespponse) {
    const remainSpins = lastRespponse.spins;
    this.spinCountFromAttack++;
    this.spinCountFromRaid++;
    let bet = this.bet || 1;
    if (
      this.autoBet &&
      ((this.spinCountFromAttack >= this.attackBetSwitch  && this.spinCountFromAttack % this.attackBetSwitch <=5) ||
      (this.spinCountFromAttack >=21 && this.spinCountFromAttack <=23)||
        (lastRespponse.raid &&
          lastRespponse.raid.coins > this.raidBetMinLimit &&
          (this.spinCountFromRaid >= this.raidBetSwitch ||
             (this.attackCountFromRaid >=3 && this.spinCountFromAttack >= this.attackRaidGap) ||
             this.spinCountFromRaid > 60)))
    ) {
      //find the max valid bet
      const superBet = lastRespponse.superBet;
      let validBet = 3;
      if(superBet && superBet.betOptions) {
        const validBets = superBet.betOptions.filter(x => x <= this.maxAutoBet);
        if(validBets.length >0) {
        validBet = validBets[validBets.length -1];
        }
      }
      bet = Math.min(validBet, remainSpins);
    }
    let response = await this.post("spin", {
      seq: this.seq + 1,
      auto_spin: "True",
      bet
    });
    if (!response) {
      response = this.getBalance(true);
    }
    let extraInfo ="";

    const { pay, r1, r2, r3, seq, coins, spins, shields, raid = {},accumulation, attackRaidMaster } = response;
    if(accumulation) {
      let reward = accumulation.reward;
      if(reward.coins ) {
        reward.coins = numeral(reward.coins).format( "$(0a)")
      }
      extraInfo =`Rewards: ${JSON.stringify(reward)}, progress: ${accumulation.currentAmount}/${accumulation.totalAmount}`.magenta
    }

    if(attackRaidMaster) {
      let reward = attackRaidMaster.reward;
      if(reward.coins ) {
        reward.coins = numeral(reward.coins).format( "$(0a)")
      }
      extraInfo =`Rewards: ${JSON.stringify(reward)}, progress: ${attackRaidMaster.counter}/${attackRaidMaster.required}`.magenta
    }

    this.updateSeq(seq);
    console.log(
      colors.green(
        `SPIN: ${r1} ${r2} ${r3} - Bet: X${bet} Pay ${pay}, Coins : ${numeral(
          coins
        ).format(
          "$(0.000a)"
        )}, Shields: ${shields}, Spins : ${spins} \t| Raid :${
          raid.name
        }(${numeral(raid.coins).format("$(0.000a)")}) H: ${
          this.spinCountFromAttack
        }  R: ${this.spinCountFromRaid} Attack Count: ${this.attackCountFromRaid} | ${extraInfo}`
      )
    );
    this.dumpFile("spin", response);
    return response;
  }
  async readSyncMessage(t) {
    this.track = this.track || {};
    if(this.track[t]) return;
    const data = {};
    data[t] = "delete";
    console.log("Read sync message", data);
    this.track[t] = true;

    return await this.post(`read_sys_messages`, data);
  }
  async popBallon(index, currentSpins) {
    // console.log("Popping baloon", index);
    const result = await this.post(`balloons/${index}/pop`);
    const { pay, coins, spins } = result;
    console.log(
      `Pop ballop result :  pay ${pay ||
        0}, coins : ${coins}, spins : ${spins} +${spins - currentSpins}`.red
    );
    return result;
  }
  // apart of handle messages list
  async collectRewards(rewardType) {
    rewardType = rewardType || "GENERIC_ACCUMULATION_REWARD";
    const url = `rewards/rewardType/collect`;
    const data = await this.post(url);
    return data;
  }
  async getBalance(silient) {
    const response = await this.post("balance", {
      extended: "true",
      config: "all",
      segmented: "true"
    });
    this.updateSeq(response.seq);
    const { coins, spins, name, shields } = response;
    if (!silient) {
      console.log(
        `BALANCE: Hello ${name}, You have ${spins} spins and ${numeral(
          coins
        ).format("$(0.000a)")} coins ${shields} shields`
      );
    }
    this.dumpFile("balance", response);
    this.onData(response);
    return response;
  }
  async feedFox(res){ 

    /*selectedPet: {type: "fox", xp: 7789, paused: false, level: 27, messages: [], ttl: 899961, nextXp: 100000,…}
    currentStealPercent: 61
    level: 27
    messages: []
    nextStealPercent: 62
    nextXp: 100000
    paused: false
    scoreBonus: 40
    ttl: 899961
    type: "fox"
    xp: 7789

    https://vik-game.moonactive.net/api/v1/users/rof4__cjzgkbk3s02cib3k76fci3yw6/pets/selected/feed

    ttl: 14400000
// request_id: 80a17e33-74d0-4fdc-9f17-bd4b8c895ab9

*/

    const {selectedPet} = res;
    if(selectedPet) {
      console.log("Your pet", selectedPet);
    }
    console.log("Feed the fox with free snack");

    res = await this.post("pets/fox/daily-mini-snack")
  }
  updateSeq(sed) {
    // console.log("SEQ", sed);
    this.seq = sed;
  }
  async waitFor(ts) {
    return new Promise(resolve => setTimeout(resolve, ts));
  }
  async update_fb_data() {
    console.log("update fb user data", this.fbUserToken);
    if (this.fbUserToken) {
      const response = await this.post("update_fb_data", {
        "User[fb_token]": this.fbUserToken,
        p: "fb",
        fbToken: null
      });
      this.fbUser = response;
      console.log("user data", response);
    }
  }
  async login(useToken) {
    let data = {
      seq: 0,
      fbToken: ""
    };
    if (useToken) data.fbToken = this.config.fbToken;

    const res = await this.post(
      "https://vik-game.moonactive.net/api/v1/users/login",
      data
    );
    console.log("Login result", res);
  }
  async play() {
    this.histories = await this.readHistoryData();
    await this.fetchMetadata();

    //await this.login();
    //await this.update_fb_data();

    let res = await this.getBalance();
    //await this.getDailyFreeRewards();
    await this.handleMessage(res);

    const firstResponse = await this.getAllMessages();
    await this.handleMessage(firstResponse);
    await this.daillySpin();
     res = await this.getBalance();
    // res = await this.collectGift(res);
    // res = await this.getBalance();
    res = await this.fixBuilding(res);
    res = await this.upgrade(res);
    var spinCount = 0;
    let spins = res.spins;
    while (spins >= this.bet) {
      await this.waitFor(this.sleep || 1000);
      let deltaSpins = "";

      res = await this.spin(res);
      const { pay, r1, r2, r3, seq } = res;
      const result = `${r1}${r2}${r3}`;
      this.histories.push({r1,r2,r3});
      let type="";
      switch (result) {
        case "333":
            type= "attack";
          res = await this.hammerAttach(res);
          deltaSpins = this.spinCountFromAttack.toString();
          this.spinCountFromAttack = 0;
          this.shieldCountFromAttack = 0;
          this.attackCountFromRaid++;
          break;
        case "444":
            type = "raid"
          console.log("Piggy Raid....", r1, r2, r3);
          deltaSpins = this.spinCountFromRaid.toString();
          this.spinCountFromRaid = 0;
          this.attackCountFromRaid =0;
          this.shieldCountFromAttack = 0;
          res = await this.raid(res);
          break;
        case "666": 
        type = "spins"
        console.log("get spin rewards", res.spins)
        break;
        case "555": 
        this.shieldCountFromAttack++;
        type = "shields"
        console.log("get shield rewards")
        break;


      }
      this.updateHistoryData(r1, r2, r3, type, deltaSpins);

      const messageResult = await this.handleMessage(res);
      if (messageResult) spins = messageResult.spins;
      if (++spinCount % this.upgradeInterval === 0) {
        await this.upgrade(res);
      }
    }
    console.log("No more spins, no more fun, good bye!".yellow);
   
    res = await this.collectGift(res);
    if (res.spins > 0) {
      await this.play();
    }
    if(this.csvStream) {
      this.csvStream.close();
    }
    await this.upgrade(res);
  }
  async handleMessage(spinResult) {
    if (!spinResult) {
      console.log("something wrong handleMessage with null".red);
      return null;
    }
    const { messages } = spinResult;
    if (!messages) return spinResult;

    //   "messages": [
    //     {
    //         "t": 1570163726965,
    //         "a": 112,
    //         "data": {
    //             "reward": {
    //                 "coins": 15000000
    //             },
    //             "rewardId": "GENERIC_ACCUMULATION_REWARD",
    //             "reason": "accumulation",
    //             "status": "PENDING_COLLECT",
    //             "collectUrl": "/api/v1/users/rof4__cjzgkbk3s02cib3k76fci3yw6/rewards/GENERIC_ACCUMULATION_REWARD/collect"
    //         }
    //     }
    // ],
    let spins = spinResult.spins;

    for (const message of messages) {
      const { data, e } = message;
      let baloonsCount = 0;
      if (data && data.status === "PENDING_COLLECT" && data.collectUrl) {
        if(data.reward && data.reward.coins) {
          data.reward.coins = numeral(data.reward.coins).format("$(0.000a)")
        }
        console.log(
          "######## Collect rewards ####".magenta,
          data.rewardId.green,
          data.reason,
          data.reward
        );
       
        await this.post("https://vik-game.moonactive.net" + data.collectUrl);
        if(data.reward && data.reward.coins) {
          await this.upgrade(spinResult);
        }
      } else if (data && data.foxFound) {
        // acttion to elimited foxFound message
      } else if (e && e.chest) {
        // console.log("You got free chest, collect it", e.chest);
        // await this.post('read_messages', {last: message.t});
      } else {
        // 3 -attack
        if (
          !message.data ||
          Object.keys(message.data).length == 0 ||
          [
            "attack_master",
            "village_complete_bonus",
            "raid_master",
            "card_swap",
            "accumulation",
            "cards_boom",
            "baloons",
            "tournaments",
            "set_blast"
          ].some(x => x === message.data.type)
        ) {
        await this.readSyncMessage(message.t);
          continue;
        }
        console.log("Need Attention: --->UNHANDLED MESSAGE<----", message);
      }
    }
    if (spinResult.balloons) {
      for (const key in spinResult.balloons) {
        if (spinResult.balloons.hasOwnProperty(key)) {
          spins = (await this.popBallon(key, spins)).spins;
        }
      }
    }
    // spinResult = await this.getBalance();
    return spinResult;
  }
  async raid(spinResult, retry) {
    console.log("************** RAID **************".magenta);
    this.dumpFile("raid", spinResult);

    const { raid } = spinResult;
    let raidVillige = raid.village;
    if (!raidVillige) {
      console.log("Raid response invalid, missing villige".red);
      raidVillige = {};
    }
    const ts = new Date().getTime();
    let time = spinResult.now;
    await this.track({
      event: "raid_start",
      msg: {
        raid_userid: spinResult.raid.id,
        raid_name: raid.name,
        raid_balance: raid.coins.toString(),
        raid_target: raid.target,
        raid_village: raidVillige.village,
        raid_house: raidVillige.House,
        raid_ship: raidVillige.Ship,
        raid_crop: raidVillige.Crop,
        raid_statue: raidVillige.Statue,
        raid_farm: raidVillige.Farm
        //"all_time_raids":"3"
      },
      time
    });
    retry = retry || 0;
    console.log(
      `Raid: ${spinResult.raid.name} Coins:  ${numeral(
        spinResult.raid.coins
      ).format("$(0.000a)")}, target: ${raid.raid_target} `
    );
    const originalCoins = spinResult.coins;

    let response = null;
    const list = [1, 2, 3, 4]
      .sort(() => Math.random() - 0.5)
      .filter(x => x != this.lastNoCoinIndex);
    const raided = [];
    let totalAmount = 0;
    for (var i = 0; i < 3; i++) {
      const slotIndex = list[i];
      response = await this.post(`raid/dig/${slotIndex}`);
      const { res, pay, coins, chest } = response;
      raided.push(pay);

      totalAmount += pay;
      if (chest) {
        console.log(`You found ${chest.type}:`.green, chest);
      }
      if (!chest && pay === 0) {
        this.lastNoCoinIndex = slotIndex;
      }
      this.dumpFile(`raid_${slotIndex}`, response);

      console.log(
        colors.magenta(
          `Raid : index ${slotIndex},  Raid Result: ${res} - Pay ${pay} => Coins : ${numeral(
            coins
          ).format("$(0.000a)")}`
        )
      );
    }
    response = await this.getBalance(true);

    const afterRaidCoins = response.coins;
    console.log(
      "######### RAID TOTAL AMOUNT ######## ".green,
      colors.red(numeral(afterRaidCoins - originalCoins).format("$(0.000a)"))
    );

    /*if (afterRaidCoins === originalCoins && retry < 1000) {
      response = await this.getBalance();
      console.log("Retry raid: ", retry + 1);
      return this.raid(response, retry + 1);
    }*/
    // raided end, update tracking

    time += new Date().getTime() - ts;
    this.track({
      event: "raid_end",
      msg: {
        dig_1_type: raided[0] > 0 ? "coins" : "no coins",
        dig_1_amount: raided[0].toString(),
        dig_2_type: raided[1] > 0 ? "coins" : "no coins",
        dig_2_amount: raided[1].toString(),
        dig_3_type: raided[2] > 0 ? "coins" : "no coins",
        dig_3_amount: raided[2].toString(),
        duration: new Date().getTime() - ts,
        target_name: spinResult.raid.name,
        attackedPerson: spinResult.raid.id,
        amount_total:
          parseInt(raided[0], 10) +
          parseInt(raided[1], 10) +
          parseInt(raided[2], 10)
      },
      time
    });
    return response;
  }
  async track(event) {
    if (!this.enableTracking) return;

    console.log("Update tracking data".yellow);
    const deviceInfo = {
      event: "device_info",
      msg: {
        os: "WebGL",
        app_version: "3.5.27",
        model: "",
        brand: "",
        manufacturer: "",
        os_version: "",
        screen_dpi: "",
        screen_height: "1440",
        screen_width: "2560",
        has_telephone: "",
        carrier: "",
        wifi: "",
        device_id: this.config["Device[udid]"],
        fullscreen: "False"
      }
      //i: "1939300993-24"
    };
    const finalEvent = {
      ...event
    };
    finalEvent.msg = {
      ...event.msg,
      device_id: this.config["Device[udid]"],
      user_id: this.userId,
      change_purpose: this.config["Device[change]"],
      ...this.profile
    };

    var data = JSON.stringify(deviceInfo) + "\n" + JSON.stringify(event);
    if (this.verbose) {
      console.log("Tracking event", event);
    }
    const result = await this.post(
      "https://vik-analytics.moonactive.net/vikings/track",
      {
        data
      }
    );
    console.log("tracking result", result);
  }
  async collectGift(spinResult) {
    console.log("Collect gift");

    let response = await this.post("inbox/pending");
    const { messages } = response;
    if (messages && messages.length > 0) {
      console.log("Your have gifts", messages);

      for (const message of messages) {
        if (message.type !== "gift" && message.type != "send_cards") continue;
        console.log("Collect gift", message);
        try {
          response = await this.post(`inbox/pending/${message.id}/collect`);
        } catch (err) {
          console.log("Error to collect gift", err.response || "Unknow");
        }
      }
    } else {
      console.log("No gift pending");
    }
    return response;
  }
  isAttackableVillage(userId, user) {
    //console.log("isAttackableVillage", user.id)
    if (!user) return false;
    const village = user.village || user;
    //console.log("going to validate ", village)

    const attackPriorities = ["Ship", "Statue", "Crop", "Farm", "House"];
    if (excludedAttack.some(x => x === userId)) return false;
    for (const item of attackPriorities) {
      if (village[item] && village[item] > 0 && village[item] < 6) return true;
    }
    return false;
  }

  //return the target
  async findRevengeAttack(spinResult) {
    if(this.enemyId) {
      const enemy = await this.getFriend(this.enemyId);
      if(this.isAttackableVillage(this.enemyId, enemy)){
        console.log("Revent the stupid enemey", enemy.id, enemy.name);
        return enemy;
      }
    }
    if (
      this.attackTarget === "random" &&
      spinResult.random &&
      this.isAttackableVillage(spinResult.random.id, spinResult.random)
    ) {
      console.log("Prefer attack random target", spinResult.random.name);
      return spinResult.random;
    }

    if (this.attackTarget.indexOf("_") >= 0) {
      console.log("get attack target", this.attackTarget);
      var friend = await this.getFriend(this.attackTarget);
      //console.log("Enemy found", friend);
      if (this.isAttackableVillage(friend.id, friend)) {
        return friend;
      }
    }

    console.log("Find revenge target".yellow);
    const data = await this.getAllMessages();
    const attackable = [];

    const hash = {};
    if (data.messages) {
      for (const message of data.messages) {
        if (!message.u) continue;
        // DO NOT ATTACK FRIENDLY EXCLUDES
        if (hash[message.u]) continue;

        const village = await this.getFriend(message.u);
        hash[message.u] = village;
        if (this.isAttackableVillage(message.u, village)) {
          attackable.push(village);
          if (this.attackPrefer === "shield" && village.shields > 0)
            return village;
          if (village.shields === 0) return village;
        }
      }
    }
    if (attackable.length > 0) return attackable[0];
    return spinResult.attack;
  }
  async hammerAttach(spinResult, desireTarget) {
    console.log("------------> Hammer Attack <-------------".blue);
    //console.log("attack", spinResult.attack);

     desireTarget = desireTarget || await this.findRevengeAttack(spinResult);
    desireTarget = desireTarget || spinResult.attack;

    if (
      desireTarget.id != this.enemyId &&
      desireTarget.id != this.attackTarget &&
      ((desireTarget.village.shields > 0 && this.attackPrefer !== "shield") ||
        excludedAttack.some(x => x === desireTarget.id))
    ) {
      desireTarget = spinResult.random;
    }
    if (!desireTarget) {
      console.error("No target to attack, something went wrong, exited");
      throw new Error("Bad process");
    }
    // console.log("desireTarget", desireTarget);
    const attackPriorities = ["Ship", "Statue", "Crop", "Farm", "House"];

    this.dumpFile("attack", spinResult);

    const targetId = desireTarget.id;

    const village = desireTarget.village;
    if (village.shields > 0) {
      console.log("Attach target has shield");
    }

    //console.log(`Attacking `, desireTarget);
    for (const item of attackPriorities) {
      if (!village[item] || village[item] === 0 || village[item] > 6) continue;
      console.log(
        colors.green(
          `Attacking ${desireTarget.name} , item = ${item}, state = ${village[item]}`
        )
      );

      const response = await this.post(
        `targets/${targetId}/attack/structures/${item}`,
        {
          state: village[item],
          item
        }
      );
      if (!response) {
        excludedAttack.push(desireTarget.id);
        return this.hammerAttach(spinResult, spinResult.random);
      }
      //this.updateSeq(response.data.seq)
      const { res, pay, coins } = response;
      console.log(`Attack Result : ${res} - Pay ${pay} => coins : ${this.numberFormat(coins)}`);
      if (res != "ok" && res != "shield") {
        console.log("Attack failed".red, response);
      }
      if (res == "shield") {
        console.log("Your attack has been blocked by shiled".yellow);
      }
      this.dumpFile("attacked", response);
      // throw new Error("stop !!!!");
      return response;
    }
    console.log("Warining : something wrong with attack".red);
    // throw new Error("STOP !!!!");
    return spinResult;
  }
  async fixBuilding(spinResult) {
    console.log("Fix damage building if any".red);
    const priority = ["Farm", "House", "Ship", "Statue", "Crop"];
    let response = spinResult;
    for (const item of priority) {
      if (spinResult[item] && spinResult[item] > 6) {
        response = await this.post("upgrade", {
          item,
          state: response[item]
        });
        const data = response;
        console.log(`Fix Result`.green, {
          Farm: data.Farm,
          House: data.House,
          Ship: data.Ship,
          Statue: data.Statue,
          Crop: data.Crop
        });
      }
    }
    return response;
  }
  /**
   * 
   * @param {*} type wooden, golden, magical
   */
  async purchase(type) {
    const response = await this.post("purchase", {
      type,
      request_id: uuid.v4()
    });
    console.log("Purchase", response.chest);
  }
  async upgrade(spinResult) {
    if (!spinResult) return;
    console.log("************************* Running Upgrade **********************".magenta);
    let maxDelta = 0;
    let coins = spinResult.coins;
    let villageLevel = spinResult.village;
    this.upgradeCost[villageLevel] = this.upgradeCost[villageLevel] = {};

    const priority = ["Ship", "Farm", "Crop",  "Statue", "House"];
    for (const item of priority) {
      if(this.priorityUpgrade && item != this.priorityUpgrade && spinResult[this.priorityUpgrade] < 5) continue;
      this.upgradeCost[villageLevel] = this.upgradeCost[villageLevel] || {};
      this.upgradeCost[villageLevel][item] = this.upgradeCost[villageLevel][item] || 0;
      if(spinResult[item] === 5) continue;
      if(this.upgradeCost[villageLevel][item] > coins ) {
        console.log("Skipped!!!. Not enought coins to upgrade, last upgrade need ", this.upgradeCost[villageLevel][item])
        continue;
      }
      console.log(
        colors.rainbow(`Upgrade structure = ${item} State = ${spinResult[item]}`)
      );
      spinResult = await this.post("upgrade", {
        item,
        state: spinResult[item]
      });
      await this.handleMessage(spinResult);
      const deltaCoins = coins - spinResult.coins;
      if(deltaCoins > 0) {
        this.upgradeCost[villageLevel][item] = deltaCoins;
        maxDelta = Math.max(maxDelta, deltaCoins);
      }
      else{
        this.upgradeCost[villageLevel][item] = Math.max(this.upgradeCost[villageLevel][item], coins);
      }
      villageLevel = spinResult.village;

      let { Farm, House, Ship, Statue, Crop, village } = spinResult;
      // await this.handleMessage(spinResult);
      const printMessage = `Upgrade Result: Village ${village} \t Farm: ${Farm} \t House: ${House} \t Statue: ${Statue} \t Crop: ${Crop} \t Ship: ${Ship} \t | Cost ${deltaCoins}`;

      if(deltaCoins >0) {
        console.log(printMessage.green);
      }
      else{
        console.log(printMessage.grey);
      }
      coins = spinResult.coins;
    }
    if(maxDelta>0 && maxDelta < spinResult.coins ) {
      await this.upgrade(spinResult);
    }
    return spinResult;
  }
}

module.exports = CoinMaster;
