// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

import {Script, console2} from "forge-std/Script.sol";
import {UniversalRewardsDistributor} from "urd/UniversalRewardsDistributor.sol";

/// @notice Deploys Morpho's Universal Rewards Distributor (unmodified, pinned at 3de504b) for Hydration reward programs.
/// @dev Environment:
///        URD_OWNER     rewards multisig (required)
///        URD_UPDATER   root-posting key (optional; left empty, the multisig owns the URD from its first
///                      block and adds the updater itself, and the deployer never holds a role)
///        URD_TIMELOCK  dispute window in seconds (default 12 hours, must be shorter than one day)
///        URD_DEPLOYER  the deployer's address, read by `check` only (optional)
///      Run with `--sender <deployer>` and a matching signer (--private-key, --account or --ledger),
///      plus `--legacy` as the money-market deploys do. The deployer must be on Hydration's
///      EVM deployer whitelist (evmAccounts.addContractDeployer), or contract creation is rejected.
contract DeployRewardsDistributor is Script {
    uint256 public constant DEFAULT_TIMELOCK = 12 hours;

    /// @dev A new submitRoot replaces the pending root and restarts its clock, so the window must end
    /// before the next daily root is posted.
    uint256 public constant EPOCH_LENGTH = 1 days;

    address internal constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev A value that is set but malformed must stop the run. `vm.envOr` with a typed default
    /// would swallow the parse error and deploy without an updater, or with the default timelock.
    function settings() public returns (address owner, address updater, uint256 timelock) {
        owner = vm.envAddress("URD_OWNER");
        string memory rawUpdater = vm.envOr("URD_UPDATER", string(""));
        updater = bytes(rawUpdater).length == 0 ? address(0) : vm.parseAddress(rawUpdater);
        string memory rawTimelock = vm.envOr("URD_TIMELOCK", string(""));
        timelock = bytes(rawTimelock).length == 0 ? DEFAULT_TIMELOCK : vm.parseUint(rawTimelock);
    }

    /// @notice Run after the broadcast, against the chain, with the same environment and the deployed
    /// address: `forge script ... --sig "check(address)" <urd> --rpc-url hydration`. The requires in
    /// `deploy` only prove the simulation; the handover is three transactions, and if the last one
    /// is dropped the deployer still owns the URD and can set roots without the timelock.
    /// @dev The code must be the pinned URD's byte for byte (it has no immutables, so both deploy paths
    /// produce exactly its runtime code): a look-alike would answer every getter below as the URD does.
    /// Code alone does not prove the storage was written by the URD's constructor, so also check the
    /// creation transaction as the README says.
    /// While it owned the URD the deployer held every power an updater has, and could have submitted a
    /// root after setting the timelock to zero, making that root acceptable at once. Set URD_DEPLOYER to
    /// the deployer's address to also check that it was left no role. Updaters cannot be listed on
    /// chain, so any other one only shows in the URD's RootUpdaterSet events. A URD that fails this
    /// check must not be funded: deploy a new one.
    function check(address deployed) external {
        (address owner, address updater, uint256 timelock) = settings();
        UniversalRewardsDistributor urd = UniversalRewardsDistributor(deployed);
        require(deployed.code.length > 0, "no contract at that address");
        require(
            deployed.codehash == keccak256(type(UniversalRewardsDistributor).runtimeCode), "not the pinned URD's code"
        );
        require(urd.owner() == owner, "owner is not URD_OWNER: the handover did not complete");
        require(urd.timelock() == timelock, "timelock differs from URD_TIMELOCK");
        require(urd.root() == bytes32(0), "a root is already set: do not fund it, deploy a new URD");
        (,, uint256 pendingValidAt) = urd.pendingRoot();
        require(pendingValidAt == 0, "a root is pending: do not fund it, deploy a new URD");
        if (updater != address(0)) require(urd.isUpdater(updater), "URD_UPDATER is not an updater");
        string memory rawDeployer = vm.envOr("URD_DEPLOYER", string(""));
        if (bytes(rawDeployer).length > 0) {
            address deployer = vm.parseAddress(rawDeployer);
            require(deployer != owner, "URD_DEPLOYER is the owner");
            require(!urd.isUpdater(deployer), "the deployer is still an updater");
        }
        console2.log("URD", deployed, "is owned by", owner);
    }

    function run() external returns (UniversalRewardsDistributor urd) {
        (address owner, address updater, uint256 timelock) = settings();
        address deployer = msg.sender;
        require(deployer != FOUNDRY_DEFAULT_SENDER, "pass --sender <deployer> with a matching signer");

        vm.startBroadcast(deployer);
        urd = deploy(owner, updater, timelock, deployer);
        vm.stopBroadcast();

        console2.log("URD", address(urd));
        console2.log("owner", urd.owner());
        console2.log("timelock (s)", urd.timelock());
        if (updater != address(0)) console2.log("updater", updater);
    }

    /// @param operator Sends the deployment transactions. With an updater, it owns the URD for two calls
    ///        (add the updater, hand ownership to `owner`) and ends with no role.
    function deploy(address owner, address updater, uint256 timelock, address operator)
        public
        returns (UniversalRewardsDistributor urd)
    {
        require(owner != address(0), "owner is zero");
        require(owner != operator, "owner must not be the deployer");
        require(timelock > 0 && timelock < EPOCH_LENGTH, "timelock must be shorter than the epoch");

        if (updater == address(0)) {
            urd = new UniversalRewardsDistributor(owner, timelock, bytes32(0), bytes32(0));
        } else {
            require(updater != owner && updater != operator, "updater must be a separate key");
            urd = new UniversalRewardsDistributor(operator, timelock, bytes32(0), bytes32(0));
            urd.setRootUpdater(updater, true);
            urd.setOwner(owner);
        }

        require(urd.owner() == owner, "owner not set");
        require(urd.timelock() == timelock, "timelock not set");
        require(urd.root() == bytes32(0), "root must start empty");
        require(!urd.isUpdater(operator), "deployer must hold no role");
        if (updater != address(0)) require(urd.isUpdater(updater), "updater not set");
    }
}
