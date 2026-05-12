// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./base/VaultBaseV2.sol";
import {MethodSchema, ParamSchema, VaultUISchema} from "./interfaces/IVaultSchemasV1.sol";

contract EvilFarm is VaultBaseV2, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    enum Camp { NONE, RED, BLUE }
    enum Identity { NONE, SOLDIER, CAPTAIN, MAJOR, COLONEL, GENERAL }

    struct Player {
        Camp camp;
        Identity identity;
        uint256 stakedAmount;
        uint256 stakeTime;
        uint256 weight;
        uint256 lastRoundParticipated;
    }

    struct Round {
        uint256 startTime;
        uint256 battleStartTime;
        uint256 endTime;
        uint256 prizePool;
        uint256 redHP;
        uint256 blueHP;
        uint256 redAttack;
        uint256 blueAttack;
        uint256 redWeight;
        uint256 blueWeight;
        uint256 lastSettleTime;
        Camp winner;
        bool ended;
    }

    uint256 public constant TREASURY_FEE = 2000; // 20%
    uint256 public constant MAX_ROUND_PRIZE = 1 ether; // 1 BNB
    uint256 public constant PRIZE_EXTRACT_RATIO = 5000; // 50%
    uint256 public constant FIRST_ROUND_PREP_TIME = 5 minutes;
    uint256 public constant SUBSEQUENT_PREP_TIME = 1 minutes;
    uint256 public constant ATTACK_INTERVAL = 10 seconds;
    uint256 public constant STAKE_LOCK_TIME = 2 hours;
    uint256 public constant BASE_HP = 50000; // 冻结规则：每轮基础血量 5 万
    uint256 public constant BUY_SPECIAL_COOLDOWN = 30 seconds;

    mapping(Identity => uint256) public identityStake;
    mapping(Identity => uint256) public identityHP;
    mapping(Identity => uint256) public identityAttack;

    IERC20 public projectToken;
    address public treasury;
    uint256 public dividendPoolBalance;
    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(address => Player) public players;
    mapping(address => uint256) public pendingRewards;
    mapping(uint256 => mapping(address => uint256)) public roundPlayerWeight;
    mapping(uint256 => mapping(address => Camp)) public roundPlayerCamp;
    mapping(uint256 => mapping(address => bool)) public rewardClaimed;
    mapping(uint256 => uint256) public roundSettledWeight;
    mapping(uint256 => uint256) public roundDistributedReward;
    mapping(address => bool) public trustedBuyCallers;
    mapping(address => uint256) public lastBuyAttackAt;
    mapping(address => uint256) public lastBuyAttackBlock;
    mapping(bytes32 => bool) public processedBuyIds;

    event TaxReceived(uint256 amount, uint256 treasuryShare, uint256 dividendShare);
    event RoundStarted(uint256 roundId, uint256 prizePool);
    event PlayerStaked(address indexed player, Camp camp, Identity identity, uint256 amount);
    event PlayerUnstaked(address indexed player, Camp camp, Identity identity, uint256 amount, bool duringPrep);
    event RewardAccrued(address indexed player, uint256 indexed roundId, uint256 amount);
    event RewardClaimed(address indexed player, uint256 amount);
    event TrustedBuyCallerUpdated(address indexed caller, bool allowed);
    event BuySpecialAttack(address indexed buyer, uint256 indexed roundId, Camp camp, Identity identity, bytes32 tradeId, uint256 buyAmountUsd, uint256 damage);
    event RoundEnded(uint256 roundId, Camp winner, uint256 prizePool);
    event EmergencyBnbSwept(address indexed operator, address indexed treasury, uint256 amount);

    constructor(address _projectToken, address _treasury) Ownable(msg.sender) {
        projectToken = IERC20(_projectToken);
        treasury = _treasury;

        identityStake[Identity.SOLDIER] = 500_000 * 1e18;
        identityHP[Identity.SOLDIER] = 5000;
        identityAttack[Identity.SOLDIER] = 10;

        identityStake[Identity.CAPTAIN] = 1_000_000 * 1e18;
        identityHP[Identity.CAPTAIN] = 10000;
        identityAttack[Identity.CAPTAIN] = 18;

        identityStake[Identity.MAJOR] = 2_000_000 * 1e18;
        identityHP[Identity.MAJOR] = 20000;
        identityAttack[Identity.MAJOR] = 35;

        identityStake[Identity.COLONEL] = 5_000_000 * 1e18;
        identityHP[Identity.COLONEL] = 50000;
        identityAttack[Identity.COLONEL] = 70;

        identityStake[Identity.GENERAL] = 10_000_000 * 1e18;
        identityHP[Identity.GENERAL] = 100000;
        identityAttack[Identity.GENERAL] = 120;


    }

    receive() external payable {
        uint256 treasuryShare = (msg.value * TREASURY_FEE) / 10000;
        uint256 dividendShare = msg.value - treasuryShare;

        (bool success, ) = treasury.call{value: treasuryShare}("");
        require(success, "Treasury transfer failed");
        dividendPoolBalance += dividendShare;

        emit TaxReceived(msg.value, treasuryShare, dividendShare);

        if ((currentRoundId == 0 || rounds[currentRoundId].ended) && dividendPoolBalance > 0) {
            _startNewRound();
        }
    }

    function _startNewRound() internal {
        currentRoundId++;
        uint256 prepTime = (currentRoundId == 1) ? FIRST_ROUND_PREP_TIME : SUBSEQUENT_PREP_TIME;
        uint256 roundPrize = (dividendPoolBalance * PRIZE_EXTRACT_RATIO) / 10000;
        if (roundPrize > MAX_ROUND_PRIZE) roundPrize = MAX_ROUND_PRIZE;
        dividendPoolBalance -= roundPrize;

        Round storage r = rounds[currentRoundId];
        r.startTime = block.timestamp;
        r.battleStartTime = block.timestamp + prepTime;
        r.prizePool = roundPrize;
        r.redHP = BASE_HP;
        r.blueHP = BASE_HP;
        r.lastSettleTime = r.battleStartTime;

        emit RoundStarted(currentRoundId, roundPrize);
    }

    function stake(Camp preferredCamp, Identity identity) external nonReentrant whenNotPaused {
        require(players[msg.sender].stakedAmount == 0, "Already staked");
        require(identity >= Identity.SOLDIER && identity <= Identity.GENERAL, "Invalid identity");
        if (identity == Identity.GENERAL) {
            require(preferredCamp == Camp.RED || preferredCamp == Camp.BLUE, "General must choose camp");
        }

        uint256 amount = identityStake[identity];
        require(amount > 0, "Invalid stake config");
        projectToken.safeTransferFrom(msg.sender, address(this), amount);

        _settleCurrentRound();
        Round storage r = rounds[currentRoundId];
        
        Camp assignedCamp = (identity == Identity.GENERAL) ? preferredCamp : (r.redHP <= r.blueHP ? Camp.RED : Camp.BLUE);
        uint256 multiplier = _getWeightMultiplier(r);
        uint256 weight = (amount * multiplier) / 10;

        players[msg.sender] = Player(assignedCamp, identity, amount, block.timestamp, weight, currentRoundId);
        roundPlayerWeight[currentRoundId][msg.sender] = weight;
        roundPlayerCamp[currentRoundId][msg.sender] = assignedCamp;

        if (assignedCamp == Camp.RED) {
            r.redHP += identityHP[identity];
            r.redAttack += identityAttack[identity];
            r.redWeight += weight;
        } else {
            r.blueHP += identityHP[identity];
            r.blueAttack += identityAttack[identity];
            r.blueWeight += weight;
        }
        emit PlayerStaked(msg.sender, assignedCamp, identity, amount);
    }

    function joinCurrentRound() external whenNotPaused {
        Player storage p = players[msg.sender];
        require(p.stakedAmount > 0, "Not staked");
        require(currentRoundId > 0, "No round");

        _settleCurrentRound();

        Round storage r = rounds[currentRoundId];
        require(!r.ended, "Round ended");
        require(p.lastRoundParticipated < currentRoundId, "Already joined");

        uint256 weight = (p.stakedAmount * _getWeightMultiplier(r)) / 10;
        p.weight = weight;
        p.lastRoundParticipated = currentRoundId;
        roundPlayerWeight[currentRoundId][msg.sender] = weight;
        roundPlayerCamp[currentRoundId][msg.sender] = p.camp;

        if (p.camp == Camp.RED) {
            r.redHP += identityHP[p.identity];
            r.redAttack += identityAttack[p.identity];
            r.redWeight += weight;
        } else if (p.camp == Camp.BLUE) {
            r.blueHP += identityHP[p.identity];
            r.blueAttack += identityAttack[p.identity];
            r.blueWeight += weight;
        } else {
            revert("Invalid camp");
        }
    }

    function unstake() external nonReentrant whenNotPaused {
        Player storage p = players[msg.sender];
        require(p.stakedAmount > 0, "Not staked");
        require(block.timestamp >= p.stakeTime + STAKE_LOCK_TIME, "Stake locked");

        _settleCurrentRound();

        Round storage r = rounds[currentRoundId];
        bool duringPrep = false;

        if (p.lastRoundParticipated == currentRoundId && !r.ended) {
            duringPrep = block.timestamp < r.battleStartTime;
            if (p.camp == Camp.RED) {
                if (duringPrep) r.redHP = r.redHP > identityHP[p.identity] ? r.redHP - identityHP[p.identity] : 0;
                r.redAttack = r.redAttack > identityAttack[p.identity] ? r.redAttack - identityAttack[p.identity] : 0;
                r.redWeight = r.redWeight > p.weight ? r.redWeight - p.weight : 0;
            } else if (p.camp == Camp.BLUE) {
                if (duringPrep) r.blueHP = r.blueHP > identityHP[p.identity] ? r.blueHP - identityHP[p.identity] : 0;
                r.blueAttack = r.blueAttack > identityAttack[p.identity] ? r.blueAttack - identityAttack[p.identity] : 0;
                r.blueWeight = r.blueWeight > p.weight ? r.blueWeight - p.weight : 0;
            }
            roundPlayerWeight[currentRoundId][msg.sender] = 0;
            roundPlayerCamp[currentRoundId][msg.sender] = Camp.NONE;
        }

        uint256 amount = p.stakedAmount;
        Camp camp = p.camp;
        Identity identity = p.identity;
        delete players[msg.sender];
        projectToken.safeTransfer(msg.sender, amount);
        emit PlayerUnstaked(msg.sender, camp, identity, amount, duringPrep);
    }

    function _settleCurrentRound() public {
        Round storage r = rounds[currentRoundId];
        if (r.ended || block.timestamp < r.battleStartTime) return;

        uint256 intervals = (block.timestamp - r.lastSettleTime) / ATTACK_INTERVAL;
        if (intervals > 0) {
            r.blueHP = r.blueHP > (intervals * r.redAttack) ? r.blueHP - (intervals * r.redAttack) : 0;
            r.redHP = r.redHP > (intervals * r.blueAttack) ? r.redHP - (intervals * r.blueAttack) : 0;
            r.lastSettleTime += intervals * ATTACK_INTERVAL;

            if (r.redHP == 0 || r.blueHP == 0) _finalizeRound(r);
        }
    }

    function _finalizeRound(Round storage r) internal {
        r.ended = true;
        r.endTime = block.timestamp;
        if (r.redHP == 0 && r.blueHP == 0) {
            dividendPoolBalance += r.prizePool;
            r.winner = Camp.NONE;
        } else {
            r.winner = (r.redHP == 0) ? Camp.BLUE : Camp.RED;
        }
        emit RoundEnded(currentRoundId, r.winner, r.prizePool);
        if (dividendPoolBalance > 0) _startNewRound();
    }

    function _getWeightMultiplier(Round storage r) internal view returns (uint256) {
        if (block.timestamp < r.battleStartTime) return 15;
        uint256 battleTime = block.timestamp - r.battleStartTime;
        if (battleTime <= 5 minutes) return 13;
        if (battleTime <= 15 minutes) return 11;
        return 10;
    }

    modifier onlyTrustedBuyCaller() {
        require(trustedBuyCallers[msg.sender], "Not trusted caller");
        _;
    }

    function setTrustedBuyCaller(address caller, bool allowed) external onlyOwner {
        require(caller != address(0), "Zero caller");
        trustedBuyCallers[caller] = allowed;
        emit TrustedBuyCallerUpdated(caller, allowed);
    }

    function emergencySweepAllBNBToTreasury() external onlyOwner {
        uint256 amount = address(this).balance;
        require(amount > 0, "No BNB");

        dividendPoolBalance = 0;
        if (currentRoundId > 0 && !rounds[currentRoundId].ended) {
            rounds[currentRoundId].prizePool = 0;
        }

        (bool ok, ) = treasury.call{value: amount}("");
        require(ok, "Sweep transfer failed");
        emit EmergencyBnbSwept(msg.sender, treasury, amount);
    }

    function onBuy(address buyer, bytes32 tradeId, uint256 buyAmountUsd, Identity identityHint)
        external
        whenNotPaused
        onlyTrustedBuyCaller
        returns (uint256 damage)
    {
        require(currentRoundId > 0, "No round");
        _settleCurrentRound();

        Round storage r = rounds[currentRoundId];
        require(!r.ended, "Round ended");
        require(block.timestamp >= r.battleStartTime, "Battle not started");

        Player storage p = players[buyer];
        require(p.stakedAmount > 0 && p.lastRoundParticipated == currentRoundId, "Buyer not active");

        Identity id = identityHint == Identity.NONE ? p.identity : identityHint;
        require(id == p.identity, "Identity mismatch");
        require(!processedBuyIds[tradeId], "Trade already processed");
        require(block.number > lastBuyAttackBlock[buyer], "One onBuy per block");
        require(block.timestamp >= lastBuyAttackAt[buyer] + BUY_SPECIAL_COOLDOWN, "onBuy cooldown");

        damage = _getSpecialDamageByUsd(id, buyAmountUsd);
        require(damage > 0, "Buy too small");
        processedBuyIds[tradeId] = true;
        if (p.camp == Camp.RED) {
            r.blueHP = r.blueHP > damage ? r.blueHP - damage : 0;
        } else if (p.camp == Camp.BLUE) {
            r.redHP = r.redHP > damage ? r.redHP - damage : 0;
        } else {
            revert("Invalid camp");
        }

        lastBuyAttackAt[buyer] = block.timestamp;
        lastBuyAttackBlock[buyer] = block.number;

        emit BuySpecialAttack(buyer, currentRoundId, p.camp, id, tradeId, buyAmountUsd, damage);

        if (r.redHP == 0 || r.blueHP == 0) {
            _finalizeRound(r);
        }
    }

    function settleReward(uint256 roundId) public whenNotPaused returns (uint256) {
        require(roundId > 0 && roundId <= currentRoundId, "Invalid round");
        Round storage r = rounds[roundId];
        require(r.ended, "Round not ended");
        require(!rewardClaimed[roundId][msg.sender], "Reward settled");

        rewardClaimed[roundId][msg.sender] = true;
        Camp camp = roundPlayerCamp[roundId][msg.sender];
        uint256 weight = roundPlayerWeight[roundId][msg.sender];

        if (camp == Camp.NONE || weight == 0 || r.winner == Camp.NONE || camp != r.winner) {
            return 0;
        }

        uint256 teamWeight = r.winner == Camp.RED ? r.redWeight : r.blueWeight;
        if (teamWeight == 0) return 0;

        uint256 settledWeight = roundSettledWeight[roundId];
        if (settledWeight >= teamWeight) return 0;

        uint256 effectiveWeight = weight;
        uint256 remainingWeight = teamWeight - settledWeight;
        if (effectiveWeight > remainingWeight) effectiveWeight = remainingWeight;

        uint256 reward = (r.prizePool * effectiveWeight) / teamWeight;

        roundSettledWeight[roundId] += effectiveWeight;
        roundDistributedReward[roundId] += reward;
        if (roundSettledWeight[roundId] == teamWeight && roundDistributedReward[roundId] < r.prizePool) {
            dividendPoolBalance += (r.prizePool - roundDistributedReward[roundId]);
            roundDistributedReward[roundId] = r.prizePool;
        }

        if (reward > 0) {
            pendingRewards[msg.sender] += reward;
            emit RewardAccrued(msg.sender, roundId, reward);
        }
        return reward;
    }

    function claimReward() external nonReentrant whenNotPaused {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "No reward");
        pendingRewards[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Claim transfer failed");
        emit RewardClaimed(msg.sender, amount);
    }



    function _getSpecialDamageByUsd(Identity id, uint256 usd18) internal pure returns (uint256) {
        if (usd18 < 10e18) return 0;
        if (id == Identity.SOLDIER) {
            if (usd18 >= 500e18) return 1000;
            if (usd18 >= 200e18) return 400;
            if (usd18 >= 100e18) return 200;
            if (usd18 >= 50e18) return 100;
            return 20;
        }
        if (id == Identity.CAPTAIN) {
            if (usd18 >= 500e18) return 1200;
            if (usd18 >= 200e18) return 600;
            if (usd18 >= 100e18) return 300;
            if (usd18 >= 50e18) return 150;
            return 30;
        }
        if (id == Identity.MAJOR) {
            if (usd18 >= 500e18) return 2500;
            if (usd18 >= 200e18) return 1000;
            if (usd18 >= 100e18) return 500;
            if (usd18 >= 50e18) return 250;
            return 50;
        }
        if (id == Identity.COLONEL) {
            if (usd18 >= 500e18) return 4000;
            if (usd18 >= 200e18) return 2000;
            if (usd18 >= 100e18) return 1000;
            if (usd18 >= 50e18) return 500;
            return 100;
        }
        if (id == Identity.GENERAL) {
            if (usd18 >= 500e18) return 7000;
            if (usd18 >= 200e18) return 3400;
            if (usd18 >= 100e18) return 1700;
            if (usd18 >= 50e18) return 850;
            return 150;
        }
        return 0;
    }

    function description() public view override returns (string memory) {
        if (currentRoundId == 0) {
            return string(
                abi.encodePacked(
                    "AnXiaoJiang Vault | Waiting first tax | DividendPool=",
                    _toString(dividendPoolBalance)
                )
            );
        }

        Round storage r = rounds[currentRoundId];
        return string(
            abi.encodePacked(
                "AnXiaoJiang Vault | Round #",
                _toString(currentRoundId),
                " | RedHP=",
                _toString(r.redHP),
                " | BlueHP=",
                _toString(r.blueHP),
                " | Pool=",
                _toString(dividendPoolBalance),
                " | Prize=",
                _toString(r.prizePool)
            )
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory) {
        MethodSchema[] memory methods = new MethodSchema[](4);

        ParamSchema[] memory stakeParams = new ParamSchema[](2);
        stakeParams[0] = ParamSchema("preferredCamp", "Preferred Camp (0=None,1=Red,2=Blue)", "uint8");
        stakeParams[1] = ParamSchema("identity", "Identity (1-5)", "uint8");

        methods[0] = MethodSchema("stake", "Stake & Join", "Join a camp by staking project token", stakeParams);
        methods[1] = MethodSchema("_settleCurrentRound", "Refresh Battle", "Settle lazy damage for current round", new ParamSchema[](0));

        ParamSchema[] memory settleParams = new ParamSchema[](1);
        settleParams[0] = ParamSchema("roundId", "Ended round id", "uint256");
        methods[2] = MethodSchema("settleReward", "Settle Reward", "Calculate and book pending reward", settleParams);

        ParamSchema[] memory buyParams = new ParamSchema[](4);
        buyParams[0] = ParamSchema("buyer", "Buyer address", "address");
        buyParams[1] = ParamSchema("tradeId", "Unique trade id", "bytes32");
        buyParams[2] = ParamSchema("buyAmountUsd", "Buy amount in USD(1e18)", "uint256");
        buyParams[3] = ParamSchema("identityHint", "Identity(0-5)", "uint8");
        methods[3] = MethodSchema("onBuy", "Special Attack", "Trusted callback to trigger buy attack", buyParams);

        return VaultUISchema("AnXiaoJiang", unicode"⚔️", "Red vs Blue battle vault", methods);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}