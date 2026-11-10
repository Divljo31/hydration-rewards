// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

import {Test, stdJson} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {UniversalRewardsDistributor} from "urd/UniversalRewardsDistributor.sol";
import {ErrorsLib} from "urd/libraries/ErrorsLib.sol";
import {DeployRewardsDistributor} from "../script/DeployRewardsDistributor.s.sol";

/// @dev Stands in for PRIME (asset 43, 6 decimals). It is etched onto PRIME's precompile address so the
/// fixture leaves, which commit to that address, are the leaves mainnet claims will use.
contract MockPrime is ERC20("PRIME", "PRIME") {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The real URD at 3de504b against trees written by src/build-tree.ts (see tools/make-fixtures.ts).
contract RewardsDistributorTest is Test {
    using stdJson for string;

    address internal constant PRIME = 0x000000000000000000000000000000010000002B;
    uint256 internal constant TIMELOCK = 12 hours;

    // Synthetic accounts from tools/make-fixtures.ts.
    address internal constant ALICE = address(uint160(0xa11ce));
    address internal constant BOB = address(uint160(0xb0b));
    address internal constant CAROL = address(bytes20(hex"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0")); // paid in epoch 1 only
    address internal constant DAVE = address(bytes20(hex"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0")); // paid in epoch 2 only

    struct Epoch {
        bytes32 root;
        address reward;
        address[] accounts;
        uint256[] claimables;
        string json;
    }

    DeployRewardsDistributor internal script;
    UniversalRewardsDistributor internal urd;
    MockPrime internal prime;
    Epoch internal epoch1;
    Epoch internal epoch2;

    address internal multisig = makeAddr("rewards multisig");
    address internal updater = makeAddr("root poster");

    function setUp() public {
        vm.etch(PRIME, address(new MockPrime()).code);
        prime = MockPrime(PRIME);

        script = new DeployRewardsDistributor();
        urd = script.deploy(multisig, updater, TIMELOCK, address(script));

        epoch1 = _load("forge-2026-11-11.json");
        epoch2 = _load("forge-2026-11-12.json");
        // Cumulative amounts: epoch 2's total covers every claim from both epochs.
        prime.mint(address(urd), _sum(epoch2.claimables));
    }

    // ---- deployment ----

    function test_DeployHandsOwnershipToMultisig() public {
        assertEq(urd.owner(), multisig);
        assertTrue(urd.isUpdater(updater));
        assertFalse(urd.isUpdater(address(script)));
        assertEq(urd.timelock(), TIMELOCK);
        assertEq(urd.root(), bytes32(0));
    }

    function test_DeployWithoutUpdaterOwnsDirectly() public {
        UniversalRewardsDistributor direct = script.deploy(multisig, address(0), TIMELOCK, address(script));
        assertEq(direct.owner(), multisig);
        assertFalse(direct.isUpdater(address(script)));
    }

    function test_DeployRejectsWindowAsLongAsTheEpoch() public {
        vm.expectRevert(bytes("timelock must be shorter than the epoch"));
        script.deploy(multisig, updater, 1 days, address(script));
    }

    /// @dev One test for everything that reads the environment, because it is shared by the whole run.
    function test_SettingsAreStrictAndCheckReadsTheDeployedContract() public {
        vm.setEnv("URD_OWNER", vm.toString(multisig));
        vm.setEnv("URD_UPDATER", vm.toString(updater));
        vm.setEnv("URD_TIMELOCK", "43200");
        (address owner, address settingsUpdater, uint256 timelock) = script.settings();
        assertEq(owner, multisig);
        assertEq(settingsUpdater, updater);
        assertEq(timelock, TIMELOCK);
        script.check(address(urd));

        // The handover stopped after the second transaction: the deployer still owns the URD.
        UniversalRewardsDistributor unfinished =
            new UniversalRewardsDistributor(address(this), TIMELOCK, bytes32(0), bytes32(0));
        unfinished.setRootUpdater(updater, true);
        vm.expectRevert(bytes("owner is not URD_OWNER: the handover did not complete"));
        script.check(address(unfinished));
        vm.expectRevert(bytes("no contract at that address"));
        script.check(makeAddr("nothing here"));

        // A truncated address or a timelock with a unit must stop the run, not fall back to a default.
        vm.setEnv("URD_UPDATER", "0x1234abcd");
        vm.expectRevert();
        script.settings();
        vm.setEnv("URD_UPDATER", vm.toString(updater));
        vm.setEnv("URD_TIMELOCK", "6h");
        vm.expectRevert();
        script.settings();

        // Left empty, the updater is optional and the timelock is 12 hours.
        vm.setEnv("URD_UPDATER", "");
        vm.setEnv("URD_TIMELOCK", "");
        (, settingsUpdater, timelock) = script.settings();
        assertEq(settingsUpdater, address(0));
        assertEq(timelock, 12 hours);
    }

    // ---- root lifecycle ----

    function test_RootIsAcceptedOnlyAfterTheTimelock() public {
        vm.prank(updater);
        urd.submitRoot(epoch1.root, bytes32(0));

        skip(TIMELOCK - 1);
        vm.expectRevert(bytes(ErrorsLib.TIMELOCK_NOT_EXPIRED));
        urd.acceptRoot();

        skip(1);
        vm.prank(makeAddr("anyone"));
        urd.acceptRoot();
        assertEq(urd.root(), epoch1.root);
    }

    function test_NewSubmissionRestartsTheTimelock() public {
        vm.prank(updater);
        urd.submitRoot(epoch1.root, bytes32(0));
        skip(6 hours);
        vm.prank(updater);
        urd.submitRoot(epoch2.root, bytes32(0));

        skip(6 hours); // 12 h after the first submission, 6 h after the second
        vm.expectRevert(bytes(ErrorsLib.TIMELOCK_NOT_EXPIRED));
        urd.acceptRoot();

        skip(6 hours);
        urd.acceptRoot();
        assertEq(urd.root(), epoch2.root);
    }

    function test_MultisigCanRevokeAPendingRoot() public {
        vm.prank(updater);
        urd.submitRoot(epoch1.root, bytes32(0));
        vm.prank(multisig);
        urd.revokePendingRoot();

        skip(TIMELOCK);
        vm.expectRevert(bytes(ErrorsLib.NO_PENDING_ROOT));
        urd.acceptRoot();
    }

    function test_UpdaterCannotSkipTheTimelockButOwnerCan() public {
        vm.prank(updater);
        vm.expectRevert(bytes(ErrorsLib.UNAUTHORIZED_ROOT_CHANGE));
        urd.setRoot(epoch1.root, bytes32(0));

        vm.prank(multisig);
        urd.setRoot(epoch1.root, bytes32(0));
        assertEq(urd.root(), epoch1.root);
    }

    // ---- claims ----

    function test_EveryEpoch1AccountCanClaim() public {
        _publish(epoch1.root);
        for (uint256 i; i < epoch1.accounts.length; ++i) {
            address account = epoch1.accounts[i];
            assertEq(_claim(epoch1, account), epoch1.claimables[i]);
            assertEq(prime.balanceOf(account), epoch1.claimables[i]);
        }
    }

    function test_Epoch2PaysOnlyTheIncrease() public {
        _publish(epoch1.root);
        assertEq(_claim(epoch1, ALICE), 1_000e6);

        _publish(epoch2.root);
        assertEq(_claim(epoch2, ALICE), 500e6);
        assertEq(prime.balanceOf(ALICE), 1_500e6);
    }

    function test_AccountAbsentFromEpoch2StillClaimsEpoch1() public {
        _publish(epoch1.root);
        _publish(epoch2.root);
        assertEq(_claim(epoch2, BOB), 250_500_000);
    }

    function test_AccountsFromEitherEpochClaimFromTheLatestTree() public {
        _publish(epoch1.root);
        _publish(epoch2.root);
        assertEq(_claim(epoch2, CAROL), 3_141_592);
        assertEq(_claim(epoch2, DAVE), 42e6);
        assertEq(prime.balanceOf(CAROL), 3_141_592);
        assertEq(prime.balanceOf(DAVE), 42e6);
    }

    function test_ClaimingTwiceReverts() public {
        _publish(epoch1.root);
        _claim(epoch1, ALICE);
        bytes32[] memory proof = _proof(epoch1, ALICE);
        vm.expectRevert(bytes(ErrorsLib.CLAIMABLE_TOO_LOW));
        urd.claim(ALICE, PRIME, _claimable(epoch1, ALICE), proof);
    }

    function test_WrongAmountReverts() public {
        _publish(epoch1.root);
        bytes32[] memory proof = _proof(epoch1, ALICE);
        vm.expectRevert(bytes(ErrorsLib.INVALID_PROOF_OR_EXPIRED));
        urd.claim(ALICE, PRIME, _claimable(epoch1, ALICE) + 1, proof);
    }

    function test_ProofFromAnOlderTreeRevertsOnceANewRootIsLive() public {
        _publish(epoch1.root);
        _publish(epoch2.root);
        bytes32[] memory staleProof = _proof(epoch1, BOB); // Bob's amount did not change, the tree did
        vm.expectRevert(bytes(ErrorsLib.INVALID_PROOF_OR_EXPIRED));
        urd.claim(BOB, PRIME, _claimable(epoch1, BOB), staleProof);
    }

    function test_AnyoneCanClaimForAnAccount() public {
        _publish(epoch1.root);
        address keeper = makeAddr("keeper");
        bytes32[] memory proof = _proof(epoch1, CAROL);
        uint256 amount = _claimable(epoch1, CAROL);

        vm.prank(keeper);
        urd.claim(CAROL, PRIME, amount, proof);
        assertEq(prime.balanceOf(CAROL), amount);
        assertEq(prime.balanceOf(keeper), 0);
    }

    function test_UnderfundedDistributorRevertsClaims() public {
        UniversalRewardsDistributor thin = script.deploy(multisig, updater, TIMELOCK, address(script));
        prime.mint(address(thin), 1e6);
        vm.prank(updater);
        thin.submitRoot(epoch1.root, bytes32(0));
        skip(TIMELOCK);
        thin.acceptRoot();

        bytes32[] memory proof = _proof(epoch1, ALICE);
        uint256 amount = _claimable(epoch1, ALICE);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds balance"));
        thin.claim(ALICE, PRIME, amount, proof);
    }

    // ---- helpers ----

    // forge-std 1.5.4's JSON readers are not `view`, so these two helpers cannot be either.
    function _load(string memory file) internal returns (Epoch memory e) {
        e.json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", file));
        e.root = e.json.readBytes32(".root");
        e.reward = e.json.readAddress(".reward");
        e.accounts = e.json.readAddressArray(".accounts");
        e.claimables = e.json.readUintArray(".claimables");
        require(e.reward == PRIME, "fixture pays another token");
        require(e.accounts.length == e.claimables.length, "fixture arrays differ in length");
    }

    function _publish(bytes32 root) internal {
        vm.prank(updater);
        urd.submitRoot(root, bytes32(0));
        skip(TIMELOCK);
        urd.acceptRoot();
    }

    function _index(Epoch storage e, address account) internal view returns (uint256) {
        for (uint256 i; i < e.accounts.length; ++i) {
            if (e.accounts[i] == account) return i;
        }
        revert("account not in fixture");
    }

    function _claimable(Epoch storage e, address account) internal view returns (uint256) {
        return e.claimables[_index(e, account)];
    }

    function _proof(Epoch storage e, address account) internal returns (bytes32[] memory) {
        return e.json.readBytes32Array(string.concat(".proofs[", vm.toString(_index(e, account)), "]"));
    }

    function _claim(Epoch storage e, address account) internal returns (uint256) {
        return urd.claim(account, PRIME, _claimable(e, account), _proof(e, account));
    }

    function _sum(uint256[] memory values) internal pure returns (uint256 total) {
        for (uint256 i; i < values.length; ++i) total += values[i];
    }
}
