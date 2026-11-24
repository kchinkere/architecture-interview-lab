(function () {
const md = LAB.md;
const S = 'LLD Interview Problems';

LAB.add('lld', S, [
{ id: 'parking-lot', title: 'Parking Lot System', level: 'intermediate', tags: ['lld', 'strategy', 'concurrency'],
  summary: 'Multi-floor lot with spot types, tickets, pluggable pricing and concurrent entry gates.',
  mock: { entities: [['ParkingLot / Floor / Spot hierarchy', 'floor'], ['Spot types sized to vehicle types', 'spot.{0,30}(type|size|compact|large)|(compact|large|motorcycle|ev)'], ['Vehicle abstraction', 'vehicle'], ['Ticket issued at entry', 'ticket'], ['Pricing / fee calculation separated', 'pric|fee|rate'], ['Gates / entry and exit panels', 'gate|entr(y|ance)|exit']],
          patterns: [['Strategy for pricing', 'strategy.{0,40}pric|pric.{0,40}strategy'], ['Strategy for spot allocation', 'strategy.{0,40}(alloc|assign|spot)|(alloc|assign).{0,40}strategy'], ['Factory for vehicles/spots', 'factory'], ['Singleton or DI for the lot', 'singleton|single instance|bean']] },
  body: md`
## Problem statement
Design a parking lot with multiple floors and several spot types (motorcycle, compact, large, EV). Vehicles enter through gates, receive a ticket, park in a suitable spot, and pay on exit based on duration. Several gates operate concurrently.

## Requirements
**Functional**
- Multiple floors, each with spots of different types.
- A vehicle gets the nearest suitable free spot; a motorcycle may use a compact spot if motorcycle spots are full (configurable).
- Issue a ticket at entry; compute the fee at exit; mark the spot free.
- Display free-spot counts per floor and type.
- Pricing rules vary (hourly, flat weekend, EV charging surcharge).

**Non-functional**
- Correct under concurrent entry from multiple gates: never assign one spot to two vehicles.
- O(1) or O(log n) spot lookup; lots can have thousands of spots.
- Pricing and allocation rules must be changeable without editing core classes.

**Out of scope (say so):** payment gateway internals, reservations, licence-plate recognition.

## Core entities
- **ParkingLot**: entry point; owns floors; issues tickets and receipts.
- **Floor**: owns spots and per-type free pools.
- **Spot**: id, type, current vehicle; knows if a vehicle fits.
- **Vehicle**: plate and type (motorcycle, car, van/truck, EV).
- **Ticket**: id, vehicle, spot, entry time.
- **PricingStrategy**: computes the fee from a ticket and exit time.
- **SpotAllocationStrategy**: picks a spot (nearest-first, fill lower floors first, EV-preferred).
- **Gate**: entry/exit terminals calling the lot.

## UML class diagram
~~~mermaid
classDiagram
  class ParkingLot { -List~Floor~ floors -Map~String,Ticket~ active +enter(Vehicle) Ticket +exit(String ticketId, Instant) Receipt }
  class Floor { -int level -Map~SpotType,Deque~Spot~~ free +tryAcquire(SpotType) Optional~Spot~ +release(Spot) }
  class Spot { -String id -SpotType type -Vehicle vehicle }
  class Vehicle { -String plate -VehicleType type }
  class Ticket { -String id -Vehicle vehicle -Spot spot -Instant entry }
  class PricingStrategy { <<interface>> +fee(Ticket, Instant) Money }
  class SpotAllocationStrategy { <<interface>> +allocate(List~Floor~, Vehicle) Optional~Spot~ }
  ParkingLot "1" *-- "1..*" Floor
  Floor "1" *-- "*" Spot
  ParkingLot o-- PricingStrategy
  ParkingLot o-- SpotAllocationStrategy
  Ticket --> Spot
  Ticket --> Vehicle
~~~

## Relationships
- Lot **composes** floors; floors **compose** spots (spots do not exist outside a floor).
- Lot **aggregates** strategies (injected, replaceable).
- Ticket **associates** with a vehicle and a spot.

## Design patterns used
- **Strategy** for pricing and for spot allocation: rules change per lot/season.
- **Factory** to create spots from a floor layout config.
- **Singleton bean** (via DI, not a static) for the lot per deployment.
- **Observer** (optional) to update display boards when spot counts change.

## Java implementation
~~~java
public enum VehicleType { MOTORCYCLE, CAR, VAN, EV_CAR }
public enum SpotType { MOTORCYCLE, COMPACT, LARGE, EV }

public record Vehicle(String plate, VehicleType type) {}

public final class Spot {
    private final String id; private final SpotType type; private final int floor;
    private volatile Vehicle vehicle;
    public Spot(String id, SpotType type, int floor) { this.id = id; this.type = type; this.floor = floor; }
    public String id() { return id; } public SpotType type() { return type; } public int floor() { return floor; }
    void occupy(Vehicle v) { this.vehicle = v; } void vacate() { this.vehicle = null; }
}

public record Ticket(String id, Vehicle vehicle, Spot spot, Instant entry) {}
public record Receipt(String ticketId, Duration duration, Money amount) {}

/** Which spot types can take a vehicle, in order of preference. */
final class Compatibility {
    static List<SpotType> spotsFor(VehicleType v) {
        return switch (v) {
            case MOTORCYCLE -> List.of(SpotType.MOTORCYCLE, SpotType.COMPACT);
            case CAR        -> List.of(SpotType.COMPACT, SpotType.LARGE);
            case EV_CAR     -> List.of(SpotType.EV, SpotType.COMPACT, SpotType.LARGE);
            case VAN        -> List.of(SpotType.LARGE);
        };
    }
}

public final class Floor {
    private final int level;
    // Free pools per type: ConcurrentLinkedDeque.poll() is atomic, so two gates can never get the same spot
    private final Map<SpotType, ConcurrentLinkedDeque<Spot>> free = new EnumMap<>(SpotType.class);
    public Floor(int level, List<Spot> spots) {
        this.level = level;
        for (SpotType t : SpotType.values()) free.put(t, new ConcurrentLinkedDeque<>());
        spots.forEach(s -> free.get(s.type()).offer(s));
    }
    public Optional<Spot> tryAcquire(SpotType t) { return Optional.ofNullable(free.get(t).poll()); }
    public void release(Spot s) { free.get(s.type()).offerFirst(s); }
    public int freeCount(SpotType t) { return free.get(t).size(); } // O(n) on CLD; keep an AtomicInteger if displayed often
    public int level() { return level; }
}

public interface SpotAllocationStrategy { Optional<Spot> allocate(List<Floor> floors, Vehicle v); }

/** Lowest floor first, preferred spot type first. */
public final class NearestFirstAllocation implements SpotAllocationStrategy {
    public Optional<Spot> allocate(List<Floor> floors, Vehicle v) {
        for (SpotType t : Compatibility.spotsFor(v.type()))
            for (Floor f : floors) {
                Optional<Spot> s = f.tryAcquire(t);
                if (s.isPresent()) return s;
            }
        return Optional.empty();
    }
}

public interface PricingStrategy { Money fee(Ticket t, Instant exit); }

public final class HourlyPricing implements PricingStrategy {
    private final Map<SpotType, Money> hourly;
    public HourlyPricing(Map<SpotType, Money> hourly) { this.hourly = Map.copyOf(hourly); }
    public Money fee(Ticket t, Instant exit) {
        long minutes = Duration.between(t.entry(), exit).toMinutes();
        long hours = Math.max(1, (minutes + 59) / 60);            // round up, minimum one hour
        return hourly.get(t.spot().type()).times(hours);
    }
}

public final class ParkingLot {
    private final List<Floor> floors;
    private final Map<String, Floor> floorByLevel;
    private final ConcurrentHashMap<String, Ticket> active = new ConcurrentHashMap<>();
    private final Set<String> platesInside = ConcurrentHashMap.newKeySet();
    private final SpotAllocationStrategy allocation; private final PricingStrategy pricing; private final Clock clock;

    public ParkingLot(List<Floor> floors, SpotAllocationStrategy a, PricingStrategy p, Clock clock) {
        this.floors = List.copyOf(floors); this.allocation = a; this.pricing = p; this.clock = clock;
        this.floorByLevel = floors.stream().collect(Collectors.toMap(f -> String.valueOf(f.level()), f -> f));
    }

    public Ticket enter(Vehicle v) {
        if (!platesInside.add(v.plate())) throw new IllegalStateException("Vehicle already inside: " + v.plate());
        Spot spot = allocation.allocate(floors, v).orElseThrow(() -> { platesInside.remove(v.plate()); return new LotFullException(v.type()); });
        spot.occupy(v);
        Ticket t = new Ticket(UUID.randomUUID().toString(), v, spot, clock.instant());
        active.put(t.id(), t);
        return t;
    }

    public Receipt exit(String ticketId) {
        Ticket t = active.remove(ticketId);                       // atomic: a ticket can only be closed once
        if (t == null) throw new InvalidTicketException(ticketId);
        Instant now = clock.instant();
        Money amount = pricing.fee(t, now);
        t.spot().vacate();
        floorByLevel.get(String.valueOf(t.spot().floor())).release(t.spot());
        platesInside.remove(t.vehicle().plate());
        return new Receipt(t.id(), Duration.between(t.entry(), now), amount);
    }
}
~~~

## Important methods explained
- {{Floor.tryAcquire}}: uses {{ConcurrentLinkedDeque.poll()}}, which is lock-free and atomic. Two gates polling concurrently receive different spots or {{null}}, so double allocation is impossible without a global lock.
- {{ParkingLot.exit}}: {{active.remove}} returns the ticket to exactly one caller, which makes exit idempotent-safe against double-submits.
- {{HourlyPricing.fee}}: rounds up to the hour with integer arithmetic, avoiding floating-point money; minimum one hour is a business rule you should confirm.

## Concurrency
- Spot allocation: lock-free pools per floor/type. Alternative: a {{ReentrantLock}} per floor (simpler to reason about when allocation needs multi-step checks).
- If the lot is backed by a database across several gate servers, use {{UPDATE spot SET vehicle=? WHERE id=? AND vehicle IS NULL}} and retry on zero rows.

## Extensibility
- New vehicle/spot type: add enum values and a compatibility entry. Consider moving compatibility to configuration.
- New pricing (weekend flat, EV surcharge): a new {{PricingStrategy}} or a decorator ({{EvSurchargePricing}} wrapping another strategy).
- Reservations: add a {{Reservation}} entity and a reserved pool per floor; allocation checks reservations first.

## Common mistakes
- One global {{synchronized}} on {{enter}}: correct but serialises all gates.
- Pricing logic inside {{Ticket}} or {{ParkingLot}} with if/else on type.
- Using {{double}} for money; ignoring rounding rules.
- Scanning every spot on every entry (O(n)) instead of keeping free pools.
- Forgetting that the same plate could try to enter twice (lost ticket / fraud).

## Follow-up questions
?? How would you show real-time availability on display boards at each floor?
Maintain {{AtomicInteger}} counters per floor/type updated on acquire/release, and publish change events (Observer). Boards subscribe; for a networked deployment push via WebSocket/SSE, throttled to one update per second per board.
?? A ticket is lost. How do you charge?
Look up by plate in the active map (keep a plate -> ticket index) and charge from recorded entry time; if not found, apply a lost-ticket policy as another pricing strategy.
?? How do you scale to 50 lots in a city with a mobile app?
Each lot runs its own service or the lot becomes a tenant in a central service; spot state lives in a database per lot with conditional updates; the app reads availability from a cache refreshed by events.
?? How would you support EV charging billing?
Separate the charging session (kWh from the charger) from parking duration; total = parking strategy + energy strategy. Compose via a {{CompositePricing}}.
` },

{ id: 'elevator', title: 'Elevator System', level: 'advanced', tags: ['lld', 'state', 'scheduling'],
  summary: 'Multiple cars, external/internal requests, a dispatcher with pluggable scheduling (SCAN/LOOK) and per-car state machines.',
  mock: { entities: [['Elevator car with state (direction, floor)', 'elevator|car'], ['Request types: hall (up/down) vs cabin', 'hall|external|internal|cabin'], ['Dispatcher / controller', 'dispatch|controller|scheduler'], ['Direction / state enum', 'direction|idle|moving|state'], ['Door handling', 'door']], patterns: [['Strategy for scheduling algorithm', 'strategy'], ['State for elevator states', 'state'], ['Observer for floor displays', 'observer|listener'], ['Command for requests', 'command|request object']] },
  body: md`
## Problem statement
Design the control system for a building with N floors and M elevator cars. Passengers press up/down buttons on floors (hall calls) and floor buttons inside cars (car calls). Minimise wait time while staying simple and safe.

## Requirements
**Functional**
- Hall call (floor, direction) is assigned to one car by a dispatcher.
- Car call (destination floor) is served by that car.
- Cars move floor by floor, stop at requested floors, open/close doors.
- Maintenance mode / out-of-service cars are excluded from dispatch.

**Non-functional**
- Scheduling algorithm must be swappable (nearest car, SCAN/LOOK, zoning for peak hours).
- Thread-safe: requests arrive concurrently while cars move.
- Safety constraints (never move with doors open, respect capacity) are invariants, not optional.

## Core entities
- **ElevatorCar**: id, current floor, direction, state, two sorted stop sets (up stops and down stops).
- **Request**: hall request (floor, direction) or car request (floor).
- **Dispatcher**: assigns hall requests to cars via a strategy.
- **DispatchStrategy**: chooses the best car.
- **ElevatorState**: IDLE, MOVING_UP, MOVING_DOWN, DOORS_OPEN, MAINTENANCE.
- **Door**: open/close with obstruction sensor.

## UML class diagram
~~~mermaid
classDiagram
  class ElevatorSystem { -List~ElevatorCar~ cars -Dispatcher dispatcher +hallCall(int, Direction) +carCall(int carId, int floor) +tick() }
  class Dispatcher { -DispatchStrategy strategy +assign(HallRequest) ElevatorCar }
  class DispatchStrategy { <<interface>> +choose(List~ElevatorCar~, HallRequest) ElevatorCar }
  class ElevatorCar { -int floor -Direction dir -State state -TreeSet~Integer~ up -TreeSet~Integer~ down +addStop(int) +step() }
  class LookStrategy
  class NearestIdleStrategy
  ElevatorSystem *-- ElevatorCar
  ElevatorSystem *-- Dispatcher
  Dispatcher o-- DispatchStrategy
  DispatchStrategy <|.. LookStrategy
  DispatchStrategy <|.. NearestIdleStrategy
~~~

## Relationships
System composes cars and the dispatcher; the dispatcher aggregates a strategy; cars own their stop queues.

## Design patterns used
- **Strategy**: dispatch algorithm (nearest idle, LOOK-cost, zoning in morning peak).
- **State**: car behaviour depends on state; illegal transitions throw.
- **Observer**: floor displays and monitoring subscribe to car position changes.
- **Command**: requests as objects so they can be queued and logged.

## Java implementation
~~~java
public enum Direction { UP, DOWN, IDLE }
public enum CarState { IDLE, MOVING, DOORS_OPEN, MAINTENANCE }
public record HallRequest(int floor, Direction direction) {}

public final class ElevatorCar {
    private final int id; private final int minFloor, maxFloor;
    private int floor; private Direction dir = Direction.IDLE; private CarState state = CarState.IDLE;
    private final TreeSet<Integer> upStops = new TreeSet<>(), downStops = new TreeSet<>();
    private final List<Consumer<ElevatorCar>> listeners = new CopyOnWriteArrayList<>();

    public ElevatorCar(int id, int min, int max) { this.id = id; this.minFloor = min; this.maxFloor = max; this.floor = min; }

    public synchronized void addStop(int target) {
        if (target < minFloor || target > maxFloor) throw new IllegalArgumentException("floor " + target);
        if (state == CarState.MAINTENANCE) throw new IllegalStateException("car " + id + " in maintenance");
        if (target > floor) upStops.add(target); else if (target < floor) downStops.add(target); else openDoors();
        if (dir == Direction.IDLE) dir = target > floor ? Direction.UP : target < floor ? Direction.DOWN : Direction.IDLE;
    }

    /** One simulation tick: LOOK algorithm. Serve stops in the current direction, reverse only when none remain. */
    public synchronized void step() {
        if (state == CarState.MAINTENANCE) return;
        if (state == CarState.DOORS_OPEN) { state = CarState.IDLE; }              // doors close (sensor checks omitted)
        if (dir == Direction.UP && upStops.isEmpty()) dir = downStops.isEmpty() ? Direction.IDLE : Direction.DOWN;
        if (dir == Direction.DOWN && downStops.isEmpty()) dir = upStops.isEmpty() ? Direction.IDLE : Direction.UP;
        if (dir == Direction.IDLE) { state = CarState.IDLE; return; }
        state = CarState.MOVING;
        floor += dir == Direction.UP ? 1 : -1;
        TreeSet<Integer> stops = dir == Direction.UP ? upStops : downStops;
        if (stops.remove(floor)) openDoors();
        listeners.forEach(l -> l.accept(this));
    }
    private void openDoors() { state = CarState.DOORS_OPEN; }

    /** Cost used by the dispatcher: distance, plus a penalty if the car must reverse first. */
    public synchronized int costTo(HallRequest r) {
        int d = Math.abs(floor - r.floor());
        if (dir == Direction.IDLE) return d;
        boolean onTheWay = (dir == Direction.UP && r.floor() >= floor && r.direction() == Direction.UP)
                        || (dir == Direction.DOWN && r.floor() <= floor && r.direction() == Direction.DOWN);
        if (onTheWay) return d;
        int turn = dir == Direction.UP ? (upStops.isEmpty() ? floor : upStops.last()) : (downStops.isEmpty() ? floor : downStops.first());
        return Math.abs(floor - turn) + Math.abs(turn - r.floor()) + 2;     // must finish current sweep first
    }
    public synchronized boolean available() { return state != CarState.MAINTENANCE; }
    public void onMove(Consumer<ElevatorCar> l) { listeners.add(l); }
    public synchronized int floor() { return floor; } public int id() { return id; }
}

public interface DispatchStrategy { ElevatorCar choose(List<ElevatorCar> cars, HallRequest r); }

public final class LeastCostStrategy implements DispatchStrategy {
    public ElevatorCar choose(List<ElevatorCar> cars, HallRequest r) {
        return cars.stream().filter(ElevatorCar::available).min(Comparator.comparingInt(c -> c.costTo(r)))
                   .orElseThrow(() -> new IllegalStateException("no car available"));
    }
}

public final class ElevatorSystem {
    private final List<ElevatorCar> cars; private volatile DispatchStrategy strategy;
    public ElevatorSystem(List<ElevatorCar> cars, DispatchStrategy s) { this.cars = List.copyOf(cars); this.strategy = s; }
    public void hallCall(int floor, Direction d) { strategy.choose(cars, new HallRequest(floor, d)).addStop(floor); }
    public void carCall(int carId, int floor) { cars.get(carId).addStop(floor); }
    public void setStrategy(DispatchStrategy s) { this.strategy = s; }   // e.g. switch to zoning at 8am
    public void tick() { cars.forEach(ElevatorCar::step); }              // driven by a ScheduledExecutorService
}
~~~

## Important methods explained
- {{step()}} implements **LOOK**: keep going while there are stops ahead, reverse when none remain. SCAN would continue to the end floor; LOOK avoids that wasted travel.
- {{costTo()}} estimates time-to-serve, penalising cars that must finish a sweep first. Real systems also weigh load, number of stops and energy.
- All car mutations are {{synchronized}} on the car: per-car locking lets cars move independently.

## Concurrency
Requests arrive from many threads while a scheduler ticks cars. Per-car monitors protect stop sets; the dispatcher reads car state under each car's lock via {{costTo}}. A hall call might be assigned using slightly stale positions, which is acceptable (re-assignment can correct it).

## Extensibility
- **Destination dispatch** (passenger enters destination in the lobby): new request type and strategy grouping passengers by destination.
- **Zoning**: cars 1-2 serve floors 1-20, cars 3-4 serve 21-40; a strategy filter.
- **Capacity**: add a load sensor; skip hall calls when full.

## Common mistakes
- A single global queue of requests processed FIFO (causes yo-yo movement).
- No distinction between hall and car calls.
- Moving with doors open: safety must be an invariant inside the car, not the dispatcher.
- Busy-waiting threads per car instead of a scheduled tick or event loop.

## Follow-up questions
?? How would you reduce average wait time in morning peak?
Park idle cars at the lobby, use zoning or destination dispatch, and switch strategy based on time of day or measured traffic (Strategy swapped at runtime).
?? How do you test this?
Drive {{tick()}} deterministically in unit tests: inject requests, tick N times, assert positions and stop order. Property tests: every request is eventually served; doors never open while moving.
?? What happens if a car fails mid-journey?
Mark it MAINTENANCE, reassign its pending hall calls to other cars (car calls cannot be moved; alert operations).
` },

{ id: 'atm', title: 'ATM Machine', level: 'intermediate', tags: ['lld', 'state', 'chain-of-responsibility'],
  summary: 'State-driven ATM session, cash dispensing via chain of responsibility, bank integration and failure safety.',
  mock: { entities: [['ATM with current state', 'atm'], ['Card / account / PIN validation via bank', 'card|pin|account'], ['Cash dispenser with denominations', 'dispens|denomination|note|cassette'], ['Transaction types', 'transaction|withdraw|deposit|balance'], ['Bank service interface', 'bank']], patterns: [['State pattern for ATM states', 'state'], ['Chain of responsibility for dispensing notes', 'chain'], ['Strategy / command for transaction types', 'strategy|command'], ['Adapter for bank network', 'adapter']] },
  body: md`
## Problem statement
Design an ATM: insert card, enter PIN, choose a transaction (withdraw, balance, deposit, transfer), dispense cash with optimal note mix, and eject the card. The ATM talks to the bank's core system over a network.

## Requirements
**Functional**
- Card insertion, PIN verification (3 attempts then retain card).
- Withdraw, balance inquiry, deposit (envelope or cash recycler), mini statement.
- Dispense using available denominations (AED 1000/500/200/100 or INR 500/200/100).
- Print receipt.

**Non-functional**
- **Money safety**: never debit without dispensing, never dispense without debiting. Reversals must be reliable.
- Operations allowed depend strictly on session state.
- Secure: PIN never stored or logged; PIN block encrypted by the PIN pad (HSM on the bank side).

## Core entities
- **ATM**: holds the current state, cash dispenser, card reader, bank client.
- **AtmState** (interface): Idle, CardInserted, Authenticated, Transacting, OutOfService.
- **CashDispenser**: cassettes per denomination; dispensing chain.
- **BankService**: authorise, debit (with idempotency key), reverse.
- **Transaction**: id, type, amount, status.

## UML class diagram
~~~mermaid
classDiagram
  class Atm { -AtmState state -CashDispenser dispenser -BankService bank +insertCard(Card) +enterPin(String) +withdraw(Money) +eject() }
  class AtmState { <<interface>> +insertCard(Atm, Card) +enterPin(Atm, String) +withdraw(Atm, Money) +eject(Atm) }
  class IdleState
  class CardInsertedState
  class AuthenticatedState
  class OutOfServiceState
  class CashDispenser { -NoteHandler chain +canDispense(int) boolean +dispense(int) Map }
  class NoteHandler { -int denomination -int count -NoteHandler next }
  class BankService { <<interface>> +verifyPin(Card, PinBlock) boolean +debit(String acct, Money, String txnId) +reverse(String txnId) }
  Atm o-- AtmState
  AtmState <|.. IdleState
  AtmState <|.. CardInsertedState
  AtmState <|.. AuthenticatedState
  AtmState <|.. OutOfServiceState
  Atm *-- CashDispenser
  CashDispenser *-- NoteHandler
  Atm o-- BankService
~~~

## Relationships
ATM composes its dispenser; it aggregates the bank client and the current state object.

## Design patterns used
- **State**: each state implements only the operations valid in it; others throw.
- **Chain of Responsibility**: each denomination handler dispenses what it can and passes the remainder.
- **Adapter**: wraps the bank switch protocol (ISO 8583) behind {{BankService}}.
- **Command/Strategy** (optional): transaction types.

## Java implementation
~~~java
public interface AtmState {
    default void insertCard(Atm atm, Card c) { throw new IllegalStateException("Card already inserted or ATM unavailable"); }
    default void enterPin(Atm atm, String pin) { throw new IllegalStateException("Insert card first"); }
    default void withdraw(Atm atm, int amount) { throw new IllegalStateException("Not authenticated"); }
    default void eject(Atm atm) { throw new IllegalStateException("No card"); }
}

final class IdleState implements AtmState {
    public void insertCard(Atm atm, Card c) { atm.setCard(c); atm.setState(new CardInsertedState()); }
}

final class CardInsertedState implements AtmState {
    private int attempts = 0;
    public void enterPin(Atm atm, String pin) {
        if (atm.bank().verifyPin(atm.card(), PinBlock.encrypt(pin, atm.card()))) { atm.setState(new AuthenticatedState()); return; }
        if (++attempts >= 3) { atm.retainCard(); atm.setState(new IdleState()); throw new CardRetainedException(); }
        throw new WrongPinException(3 - attempts);
    }
    public void eject(Atm atm) { atm.returnCard(); atm.setState(new IdleState()); }
}

final class AuthenticatedState implements AtmState {
    public void withdraw(Atm atm, int amount) {
        if (amount <= 0 || amount % atm.dispenser().smallestNote() != 0) throw new IllegalArgumentException("Invalid amount");
        if (!atm.dispenser().canDispense(amount)) throw new InsufficientCashInAtmException();
        String txnId = atm.newTxnId();
        atm.bank().debit(atm.card().account(), amount, txnId);          // idempotent by txnId on the bank side
        try {
            atm.dispenser().dispense(amount);
        } catch (DispenseFailedException e) {
            atm.bank().reverse(txnId);                                   // compensate; retried by a reversal queue if this fails
            atm.setState(new OutOfServiceState());
            throw e;
        }
        atm.printReceipt(txnId, amount);
    }
    public void eject(Atm atm) { atm.returnCard(); atm.setState(new IdleState()); }
}

final class OutOfServiceState implements AtmState {}

/** Chain of responsibility over denominations, largest first. */
final class NoteHandler {
    final int denomination; int count; final NoteHandler next;
    NoteHandler(int d, int c, NoteHandler next) { this.denomination = d; this.count = c; this.next = next; }

    /** Plan without mutating, so we can check feasibility before debiting the account. */
    boolean plan(int amount, Map<Integer, Integer> out) {
        int use = Math.min(amount / denomination, count);
        // greedy can fail for some note sets (e.g. 500/200 for 600): backtrack by using fewer of this note
        for (int u = use; u >= 0; u--) {
            int rest = amount - u * denomination;
            Map<Integer, Integer> trial = new HashMap<>(out);
            if (u > 0) trial.put(denomination, u);
            if (rest == 0 || (next != null && next.plan(rest, trial))) { out.clear(); out.putAll(trial); return true; }
        }
        return false;
    }
}

public final class CashDispenser {
    private final NoteHandler chain;
    public CashDispenser(SortedMap<Integer, Integer> cassettes) {           // denomination -> count
        NoteHandler h = null;
        for (int d : cassettes.keySet()) h = new NoteHandler(d, cassettes.get(d), h); // build smallest..largest, so head is largest
        this.chain = h;
    }
    public synchronized boolean canDispense(int amount) { return chain.plan(amount, new HashMap<>()); }
    public synchronized Map<Integer, Integer> dispense(int amount) {
        Map<Integer, Integer> plan = new HashMap<>();
        if (!chain.plan(amount, plan)) throw new DispenseFailedException("cannot make " + amount);
        for (NoteHandler h = chain; h != null; h = h.next) h.count -= plan.getOrDefault(h.denomination, 0);
        hardware.eject(plan);                                               // physical dispense
        return plan;
    }
    public int smallestNote() { NoteHandler h = chain; while (h.next != null) h = h.next; return h.denomination; }
}
~~~

## Important methods explained
- {{AuthenticatedState.withdraw}}: checks feasibility first, debits with an idempotency key, dispenses, and **compensates** on hardware failure. In real networks the reversal is persisted to a local journal and retried until the bank acknowledges.
- {{NoteHandler.plan}}: greedy with backtracking. Pure greedy fails for 600 with only 500 and 200 notes (500 + ? fails, but 3 × 200 works).

## Concurrency
An ATM serves one session at a time, so contention is low; the dispenser is still synchronized because the replenishment/maintenance thread updates counts. The bank side must handle concurrent withdrawals on the same account from different channels (row lock or conditional update on balance).

## Extensibility
- New transaction (cardless withdrawal via QR/OTP): a new state entry path; the {{AuthenticatedState}} is reused.
- New denomination: configuration only.
- Multi-currency: dispenser per currency.

## Common mistakes
- A big {{switch(state)}} in every method.
- Debiting after dispensing (customer gets money if the debit fails), or no reversal path.
- Pure greedy note selection.
- Logging the PIN or card number (PCI DSS violation).

## Follow-up questions
?? The network drops after the bank debited but before the ATM got the response. What now?
The ATM times out and does not dispense; it records the transaction as "unknown" and sends a reversal with the same txnId. The bank's reversal is idempotent; if the debit never happened the reversal is a no-op. This is why every message carries a unique transaction id.
?? How would you test the state machine?
Unit-test each state's allowed and forbidden operations; table-driven tests of event sequences; fault injection on dispenser and bank client.
` },

{ id: 'library', title: 'Library Management System', level: 'beginner', tags: ['lld', 'crud', 'observer'],
  summary: 'Books vs copies, members, loans, reservations queue, fines with strategy, and notifications.',
  mock: { entities: [['Book (title metadata) vs BookCopy (physical item)', 'copy|item'], ['Member with borrowing limits', 'member'], ['Loan with due date', 'loan|borrow|due'], ['Reservation / hold queue', 'reserv|hold|queue'], ['Fine calculation', 'fine|penalt'], ['Catalog search', 'catalog|search']], patterns: [['Strategy for fine policy', 'strategy'], ['Observer for availability notification', 'observer|notif'], ['Repository abstraction', 'repositor'], ['Factory for member types', 'factory']] },
  body: md`
## Problem statement
Design a library system: members search the catalogue, borrow and return copies, reserve titles that are out, and pay fines for late returns. Librarians manage inventory.

## Requirements
**Functional**
- Search by title, author, ISBN, subject.
- Borrow a copy (limit per member type), return, renew (if no reservation pending).
- Reserve a title when no copy is available; notify the first in queue when a copy returns; hold for 48 hours.
- Fines per day late, capped; members with unpaid fines above a threshold cannot borrow.

**Non-functional**
- Two members must not borrow the same copy concurrently.
- Fine rules and member limits are configurable.

## Core entities
- **Book**: ISBN, title, authors (catalogue record).
- **BookCopy**: barcode, book, status (AVAILABLE, LOANED, ON_HOLD, LOST).
- **Member**: id, type (student, staff), limits, fines.
- **Loan**: copy, member, borrowedAt, dueAt, returnedAt.
- **Reservation**: book, member, createdAt, status; FIFO per book.
- **FinePolicy**: computes fine.
- **LibraryService**: borrow/return/reserve use cases.

## UML class diagram
~~~mermaid
classDiagram
  class Book { +String isbn +String title +List~String~ authors }
  class BookCopy { +String barcode +CopyStatus status }
  class Member { +String id +MemberType type +Money outstandingFines }
  class Loan { +Instant borrowedAt +LocalDate due +Instant returnedAt }
  class Reservation { +Instant createdAt +ReservationStatus status }
  class FinePolicy { <<interface>> +fine(Loan, LocalDate) Money }
  Book "1" o-- "*" BookCopy
  Loan --> BookCopy
  Loan --> Member
  Reservation --> Book
  Reservation --> Member
  LibraryService ..> FinePolicy
~~~

## Relationships
A Book aggregates many copies; Loan and Reservation are association classes linking members to copies/books.

## Design patterns used
- **Strategy**: {{FinePolicy}} (per member type, holidays excluded).
- **Observer**: copy returned -> reservation service notifies the next member.
- **Repository**: storage abstraction.
- **Factory**: member limits per member type.

## Java implementation
~~~java
public enum CopyStatus { AVAILABLE, LOANED, ON_HOLD, LOST }
public record Book(String isbn, String title, List<String> authors) {}

public final class BookCopy {
    private final String barcode; private final Book book; private CopyStatus status = CopyStatus.AVAILABLE; private String holdFor;
    BookCopy(String barcode, Book book) { this.barcode = barcode; this.book = book; }
    synchronized boolean checkout(String memberId) {
        boolean ok = status == CopyStatus.AVAILABLE || (status == CopyStatus.ON_HOLD && memberId.equals(holdFor));
        if (ok) { status = CopyStatus.LOANED; holdFor = null; }
        return ok;
    }
    synchronized void returnTo(Optional<String> nextReserver) {
        status = nextReserver.isPresent() ? CopyStatus.ON_HOLD : CopyStatus.AVAILABLE; holdFor = nextReserver.orElse(null);
    }
    public Book book() { return book; } public String barcode() { return barcode; }
}

public interface FinePolicy { Money fine(Loan loan, LocalDate returnedOn); }
public final class DailyCappedFine implements FinePolicy {
    private final Money perDay, cap;
    public DailyCappedFine(Money perDay, Money cap) { this.perDay = perDay; this.cap = cap; }
    public Money fine(Loan l, LocalDate returned) {
        long late = Math.max(0, ChronoUnit.DAYS.between(l.due(), returned));
        Money f = perDay.times(late); return f.compareTo(cap) > 0 ? cap : f;
    }
}

public final class LibraryService {
    private final CopyRepository copies; private final LoanRepository loans; private final MemberRepository members;
    private final ReservationQueue reservations; private final FinePolicy fines; private final Notifier notifier; private final Clock clock;
    // constructor omitted

    public Loan borrow(String memberId, String barcode) {
        Member m = members.get(memberId);
        if (loans.activeCount(memberId) >= m.type().maxLoans()) throw new LimitExceededException();
        if (m.outstandingFines().compareTo(m.type().fineBlockThreshold()) > 0) throw new FinesOutstandingException();
        BookCopy copy = copies.get(barcode);
        if (!copy.checkout(memberId)) throw new CopyUnavailableException(barcode);
        reservations.fulfil(copy.book().isbn(), memberId);
        Loan loan = new Loan(UUID.randomUUID().toString(), copy, m, clock.instant(), LocalDate.now(clock).plusDays(m.type().loanDays()));
        return loans.save(loan);
    }

    public Money returnCopy(String barcode) {
        Loan loan = loans.activeFor(barcode).orElseThrow(() -> new NoActiveLoanException(barcode));
        LocalDate today = LocalDate.now(clock);
        Money fine = fines.fine(loan, today);
        loan.close(clock.instant(), fine);
        Optional<String> next = reservations.nextFor(loan.copy().book().isbn());
        loan.copy().returnTo(next);
        next.ifPresent(memberId -> notifier.notify(memberId, "Your reserved book is ready for 48 hours"));
        if (fine.isPositive()) members.addFine(loan.member().id(), fine);
        return fine;
    }
}
~~~

## Important methods explained
- {{BookCopy.checkout}}: the copy itself guards the AVAILABLE/ON_HOLD transition under its monitor (in a DB: a conditional update on status).
- {{returnCopy}}: closes the loan, computes the fine via strategy, and either frees the copy or places it on hold for the next reserver.

## Extensibility
Digital loans (e-books with N concurrent licences) become another copy type; new member types are configuration; holiday-aware fines are a decorator over the fine policy.

## Common mistakes
- Not separating Book (metadata) from BookCopy (physical item).
- Reservation on a specific copy instead of the title.
- Fine logic hard-coded in the service.

## Follow-up questions
?? Hold expires after 48 hours. How?
Store {{holdExpiresAt}}; a scheduled job (or delayed message) releases expired holds to the next reserver. Make it idempotent.
?? How do you implement search at scale?
Index the catalogue in Elasticsearch/OpenSearch (title, author, subject with analyzers); keep PostgreSQL as source of truth and sync via change events.
` },

{ id: 'food-ordering', title: 'Food Ordering System', level: 'intermediate', tags: ['lld', 'state', 'observer'],
  summary: 'Restaurants, menus, cart, order lifecycle state machine, pricing pipeline and delivery assignment.',
  mock: { entities: [['Restaurant and Menu / MenuItem', 'restaurant|menu'], ['Cart tied to one restaurant', 'cart'], ['Order with line items and status', 'order'], ['Payment', 'payment'], ['Delivery partner / assignment', 'deliver|rider|partner'], ['Pricing: discounts, fees, taxes', 'discount|coupon|tax|fee']], patterns: [['State for order lifecycle', 'state'], ['Strategy for rider assignment / pricing', 'strategy'], ['Observer for status notifications', 'observer|notif|event'], ['Decorator / chain for price adjustments', 'decorator|chain|pipeline']] },
  body: md`
## Problem statement
Design the core of a food ordering app (Talabat / Zomato-style): browse restaurants, build a cart, place an order, pay, track the order through preparation and delivery.

## Requirements
**Functional**
- Restaurants with menus and item availability; cart restricted to one restaurant.
- Price = items + add-ons - discounts (coupons) + delivery fee + VAT (5% in UAE, GST in India).
- Order lifecycle: PLACED -> ACCEPTED -> PREPARING -> READY -> PICKED_UP -> DELIVERED, or CANCELLED/REJECTED.
- Assign a delivery partner; notify the customer on every status change.

**Non-functional**
- Price shown at checkout must equal price charged (snapshot prices into the order).
- Illegal status transitions rejected; concurrent updates (restaurant accepts while customer cancels) resolved deterministically.

## Core entities
- **Restaurant**, **MenuItem** (price, availability, add-ons).
- **Cart** (restaurantId, lines).
- **Order** (snapshot of lines and prices, status, payment ref).
- **PriceCalculator** with ordered **PriceRule**s.
- **DeliveryAssignmentStrategy**.
- **OrderStatus** state machine.

## UML class diagram
~~~mermaid
classDiagram
  class Cart { -String restaurantId -List~CartLine~ lines +add(MenuItem, int) +clear() }
  class Order { -String id -List~OrderLine~ lines -PriceBreakdown price -OrderStatus status +transition(OrderStatus) }
  class PriceCalculator { -List~PriceRule~ rules +calculate(Cart, Context) PriceBreakdown }
  class PriceRule { <<interface>> +apply(PriceBreakdown, Context) PriceBreakdown }
  class DeliveryAssignmentStrategy { <<interface>> +assign(Order, List~Rider~) Optional~Rider~ }
  Cart --> MenuItem
  Order *-- OrderLine
  PriceCalculator o-- PriceRule
  OrderService ..> PriceCalculator
  OrderService ..> DeliveryAssignmentStrategy
~~~

## Relationships
Order composes its lines (snapshotted); the calculator aggregates an ordered list of rules.

## Design patterns used
- **State** (enum with allowed transitions) for the order lifecycle.
- **Chain/pipeline of Strategy rules** for pricing: subtotal -> coupon -> delivery fee -> tax. Order matters (tax after discount).
- **Strategy** for rider assignment (nearest, batching, fairness).
- **Observer / domain events** for notifications and analytics.

## Java implementation
~~~java
public enum OrderStatus {
    PLACED, ACCEPTED, PREPARING, READY, PICKED_UP, DELIVERED, CANCELLED, REJECTED;
    private static final Map<OrderStatus, Set<OrderStatus>> NEXT = Map.of(
        PLACED, EnumSet.of(ACCEPTED, REJECTED, CANCELLED),
        ACCEPTED, EnumSet.of(PREPARING, CANCELLED),
        PREPARING, EnumSet.of(READY),
        READY, EnumSet.of(PICKED_UP),
        PICKED_UP, EnumSet.of(DELIVERED),
        DELIVERED, EnumSet.noneOf(OrderStatus.class),
        CANCELLED, EnumSet.noneOf(OrderStatus.class),
        REJECTED, EnumSet.noneOf(OrderStatus.class));
    public boolean canMoveTo(OrderStatus n) { return NEXT.get(this).contains(n); }
}

public record PriceBreakdown(Money subtotal, Money discount, Money deliveryFee, Money tax) {
    public Money total() { return subtotal.minus(discount).plus(deliveryFee).plus(tax); }
}
public interface PriceRule { PriceBreakdown apply(PriceBreakdown p, PricingContext ctx); }

public final class CouponRule implements PriceRule {
    public PriceBreakdown apply(PriceBreakdown p, PricingContext ctx) {
        return ctx.coupon().filter(c -> c.validFor(ctx))
            .map(c -> new PriceBreakdown(p.subtotal(), c.discountOn(p.subtotal()), p.deliveryFee(), p.tax()))
            .orElse(p);
    }
}
public final class VatRule implements PriceRule {
    private final BigDecimal rate;  // 0.05 for UAE VAT
    public VatRule(BigDecimal rate) { this.rate = rate; }
    public PriceBreakdown apply(PriceBreakdown p, PricingContext ctx) {
        Money taxable = p.subtotal().minus(p.discount()).plus(p.deliveryFee());
        return new PriceBreakdown(p.subtotal(), p.discount(), p.deliveryFee(), taxable.times(rate));
    }
}

public final class PriceCalculator {
    private final List<PriceRule> rules;   // ordered: coupon, delivery fee, VAT
    public PriceCalculator(List<PriceRule> rules) { this.rules = List.copyOf(rules); }
    public PriceBreakdown calculate(Cart cart, PricingContext ctx) {
        PriceBreakdown p = new PriceBreakdown(cart.subtotal(), Money.zero(ctx.currency()), Money.zero(ctx.currency()), Money.zero(ctx.currency()));
        for (PriceRule r : rules) p = r.apply(p, ctx);
        return p;
    }
}

public final class Order {
    private final String id; private final List<OrderLine> lines; private final PriceBreakdown price;
    private OrderStatus status = OrderStatus.PLACED; private long version;
    // ...
    public synchronized void transition(OrderStatus next) {
        if (!status.canMoveTo(next)) throw new IllegalTransitionException(status, next);
        status = next; version++;
        DomainEvents.raise(new OrderStatusChanged(id, next));
    }
}
~~~

## Important methods explained
- {{OrderStatus.canMoveTo}}: the whole lifecycle is data, easy to review and test. Persist with {{UPDATE orders SET status=?, version=version+1 WHERE id=? AND status=? }} so a cancel and an accept racing on different pods cannot both win.
- {{PriceCalculator}}: rules are ordered and pure, so the same calculator runs in cart preview and in order placement (guaranteeing same price).

## Extensibility
Surge delivery fee, loyalty points, restaurant-funded discounts: new {{PriceRule}}s. Scheduled orders: a new initial state SCHEDULED. Group orders: multiple carts merged into one order.

## Common mistakes
- Reading menu prices at delivery time instead of snapshotting at order time.
- Tax computed before discounts (or on the wrong base).
- Status as free-text string updated without transition checks.

## Follow-up questions
?? Customer cancels at the same moment the restaurant accepts. Who wins?
Whichever conditional update commits first; the loser sees zero rows updated and gets a 409 with the current state. Business rule decides if cancellation after acceptance is allowed (maybe with a fee).
?? How do you choose a rider?
Strategy using ETA to restaurant (from geo index), current load, and acceptance rate; offer to top-k riders sequentially with timeouts. See the Food Delivery system design for the distributed version.
` },

{ id: 'movie-booking', title: 'Movie Ticket Booking', level: 'advanced', tags: ['lld', 'concurrency', 'locking'],
  summary: 'Theatres, shows, seat maps, temporary seat holds with expiry, and concurrency-safe booking.',
  mock: { entities: [['Movie, Theatre, Screen, Show', 'show|screen|theat'], ['Seat and ShowSeat (seat state per show)', 'showseat|show seat|seat.{0,20}(status|state)'], ['Booking with status', 'booking'], ['Temporary hold / lock with expiry', 'hold|lock|expir|ttl'], ['Payment', 'payment']], patterns: [['Strategy for pricing (seat class, time)', 'strategy'], ['State for booking/seat status', 'state'], ['Observer for notification', 'observer|notif'], ['Optimistic / pessimistic locking', 'optimistic|pessimistic|for update|version']] },
  body: md`
## Problem statement
Design BookMyShow / VOX Cinemas-style booking: users pick a show, select seats on a seat map, hold them for a few minutes while paying, and get a confirmed booking. The core challenge is **no double booking under heavy concurrency**.

## Requirements
**Functional**
- Browse movies, theatres, shows by city and date.
- View seat map with live availability.
- Hold selected seats for N minutes (e.g. 8); release on timeout or payment failure.
- Confirm booking on successful payment; issue ticket.
- Pricing by seat category and show time.

**Non-functional**
- Strong consistency for seat state: a seat is sold at most once.
- Seat map reads are far more frequent than holds (cacheable with short TTL).
- Holds must expire reliably even if the app instance crashes.

## Core entities
- **Movie**, **Theatre**, **Screen** (layout of seats), **Show** (movie + screen + start time).
- **Seat** (row, number, category) and **ShowSeat** (seat state per show: AVAILABLE, HELD, BOOKED, heldBy, holdExpiresAt).
- **Booking** (user, show, seats, amount, status: PENDING, CONFIRMED, EXPIRED, CANCELLED).
- **SeatHoldService**, **PricingStrategy**, **PaymentPort**.

## UML class diagram
~~~mermaid
classDiagram
  class Show { +String id +Movie movie +Screen screen +Instant start }
  class ShowSeat { +String seatId +SeatState state +String heldBy +Instant holdExpiresAt +long version }
  class Booking { +String id +List~String~ seats +Money amount +BookingStatus status }
  class SeatHoldService { +hold(showId, seats, userId) Booking +confirm(bookingId, paymentRef) +expireHolds() }
  class PricingStrategy { <<interface>> +price(Show, List~Seat~) Money }
  Show "1" *-- "*" ShowSeat
  Booking --> Show
  SeatHoldService ..> ShowSeat
  SeatHoldService ..> PricingStrategy
~~~

## Relationships
A Show composes its ShowSeats (state per show, created from the Screen layout). Booking references seats by id.

## Design patterns used
- **State** for seat and booking status with explicit transitions.
- **Strategy** for pricing.
- **Observer/events** for confirmation e-mails and analytics.
- Concurrency control: **atomic conditional update** (DB) as the source of truth.

## Java implementation
~~~java
public enum SeatState { AVAILABLE, HELD, BOOKED }

/** In-memory version for the interview; production uses the SQL below as the source of truth. */
public final class ShowSeatMap {
    private final ConcurrentHashMap<String, ShowSeat> seats;
    public ShowSeatMap(Collection<ShowSeat> s) { this.seats = new ConcurrentHashMap<>(); s.forEach(x -> seats.put(x.id(), x)); }

    /** All-or-nothing hold. Lock seats in sorted id order to avoid deadlock between overlapping requests. */
    public boolean hold(List<String> seatIds, String user, Instant until, Instant now) {
        List<ShowSeat> ordered = seatIds.stream().sorted().map(seats::get).toList();
        if (ordered.contains(null)) throw new IllegalArgumentException("unknown seat");
        ordered.forEach(s -> s.lock.lock());
        try {
            for (ShowSeat s : ordered) if (!s.isFree(now)) return false;   // expired holds count as free
            for (ShowSeat s : ordered) s.hold(user, until);
            return true;
        } finally { ordered.forEach(s -> s.lock.unlock()); }
    }

    public void confirm(List<String> seatIds, String user, Instant now) {
        List<ShowSeat> ordered = seatIds.stream().sorted().map(seats::get).toList();
        ordered.forEach(s -> s.lock.lock());
        try {
            for (ShowSeat s : ordered) if (!s.isHeldBy(user, now)) throw new HoldExpiredException(s.id());
            ordered.forEach(ShowSeat::book);
        } finally { ordered.forEach(s -> s.lock.unlock()); }
    }
}

public final class ShowSeat {
    final ReentrantLock lock = new ReentrantLock();
    private final String id; private SeatState state = SeatState.AVAILABLE; private String heldBy; private Instant expires;
    ShowSeat(String id) { this.id = id; }
    boolean isFree(Instant now) { return state == SeatState.AVAILABLE || (state == SeatState.HELD && expires.isBefore(now)); }
    boolean isHeldBy(String u, Instant now) { return state == SeatState.HELD && u.equals(heldBy) && expires.isAfter(now); }
    void hold(String u, Instant until) { state = SeatState.HELD; heldBy = u; expires = until; }
    void book() { state = SeatState.BOOKED; }
    String id() { return id; }
}

@Service
public class BookingService {
    private final ShowSeatJdbc seatsDb; private final BookingRepository bookings; private final PricingStrategy pricing; private final Clock clock;
    // constructor omitted

    @Transactional
    public Booking hold(String showId, List<String> seatIds, String userId) {
        Instant now = clock.instant(), until = now.plus(Duration.ofMinutes(8));
        int updated = seatsDb.holdIfFree(showId, seatIds, userId, until, now);   // single conditional UPDATE
        if (updated != seatIds.size()) throw new SeatsUnavailableException();   // @Transactional rolls back partial holds
        Money amount = pricing.price(showId, seatIds);
        return bookings.save(Booking.pending(showId, seatIds, userId, amount, until));
    }
}
~~~
~~~sql
-- holdIfFree: atomic compare-and-set across all requested seats
UPDATE show_seat
   SET state = 'HELD', held_by = :user, hold_expires_at = :until, version = version + 1
 WHERE show_id = :showId
   AND seat_id = ANY(:seatIds)
   AND (state = 'AVAILABLE' OR (state = 'HELD' AND hold_expires_at < :now));

-- confirm (after payment success webhook), idempotent
UPDATE show_seat SET state = 'BOOKED'
 WHERE show_id = :showId AND seat_id = ANY(:seatIds) AND state = 'HELD' AND held_by = :user;
~~~

## Important methods explained
- {{holdIfFree}}: one statement, row locks taken by the DB, expired holds treated as free. If fewer rows updated than requested, roll back: all-or-nothing.
- Expiry does **not** require a background job for correctness (expired holds are free by predicate); a cleanup job only tidies state and releases bookings.
- Lock ordering by seat id in the in-memory version prevents deadlock between overlapping selections.

## Extensibility
Dynamic pricing (demand-based) as a pricing strategy; group bookings; seat-category upgrades; food add-ons as booking line items.

## Common mistakes
- Check-then-update in two statements (race).
- Using a distributed lock per show (serialises a whole show; poor throughput) when row-level conditional updates suffice.
- Relying on a scheduled job alone to release holds (crash = seats stuck).
- Confirming a booking after the hold expired because the payment callback came late. You must check the hold and, if lost, refund.

## Follow-up questions
?? Payment succeeds but the hold expired and someone else booked the seat. What happens?
The confirm update affects zero rows; mark booking FAILED and trigger an automatic refund (idempotent by booking id). Keep hold TTL longer than the payment provider's session timeout to make this rare.
?? 100k users hit a blockbuster release at 10:00. How do you protect the DB?
Virtual waiting room (queue tokens), seat map from cache, holds per show partitioned by show id, rate limit per user, and keep the hold transaction tiny.
?? Would you use Redis for holds?
Possible: {{SET seat:{show}:{seat} user NX PX 480000}} per seat, but multi-seat all-or-nothing needs a Lua script, and you still need the DB as the source of truth for booked seats. Use Redis for speed only if DB contention is proven.
` },

{ id: 'splitwise', title: 'Splitwise (Expense Sharing)', level: 'intermediate', tags: ['lld', 'strategy', 'graph'],
  summary: 'Groups, expenses with equal/exact/percentage splits, balance ledger and debt simplification.',
  mock: { entities: [['User and Group', 'group'], ['Expense with payer and splits', 'expense'], ['Split types: equal, exact, percentage', 'equal|exact|percent'], ['Balance sheet / ledger between pairs', 'balance|ledger|owe'], ['Settlement / settle-up', 'settle']], patterns: [['Strategy for split type', 'strategy'], ['Factory for creating splits', 'factory'], ['Greedy / heap for simplifying debts', 'simplif|heap|greedy|min.?cash']] },
  body: md`
## Problem statement
Users add shared expenses in groups; the system tracks who owes whom and can simplify debts so the group settles with the fewest transfers.

## Requirements
**Functional**
- Add expense: payer, amount, participants, split type (EQUAL, EXACT, PERCENT, SHARES).
- Show balances per user and per pair; settle up (record payment).
- Simplify debts within a group.
- Multi-currency (AED, INR) with conversion at expense time (optional).

**Non-functional**
- Money arithmetic exact (BigDecimal / minor units) with deterministic rounding; splits must sum exactly to the total.
- Audit trail: expenses are immutable; edits create a new version.

## Core entities
- **User**, **Group** (members).
- **Expense** (id, payer, amount, splits, createdAt).
- **Split** (user, amount owed).
- **SplitStrategy**: EQUAL, EXACT, PERCENT.
- **BalanceSheet**: net balance per user (positive = is owed).
- **DebtSimplifier**.

## UML class diagram
~~~mermaid
classDiagram
  class Expense { +String id +String paidBy +long amountMinor +List~Split~ splits }
  class Split { +String userId +long owedMinor }
  class SplitStrategy { <<interface>> +split(long total, List~String~ users, Map params) List~Split~ }
  class EqualSplit
  class ExactSplit
  class PercentSplit
  class BalanceSheet { -Map~String,Long~ net +apply(Expense) +settle(from,to,amount) }
  class DebtSimplifier { +simplify(Map~String,Long~) List~Transfer~ }
  Expense *-- Split
  SplitStrategy <|.. EqualSplit
  SplitStrategy <|.. ExactSplit
  SplitStrategy <|.. PercentSplit
~~~

## Relationships
Expense composes splits; Group aggregates users and owns a balance sheet.

## Design patterns used
- **Strategy** for split calculation.
- **Factory** mapping split type -> strategy.
- Greedy algorithm with **priority queues** for debt simplification.

## Java implementation
~~~java
public record Split(String userId, long owedMinor) {}
public interface SplitStrategy { List<Split> split(long totalMinor, List<String> users, Map<String, BigDecimal> params); }

public final class EqualSplit implements SplitStrategy {
    public List<Split> split(long total, List<String> users, Map<String, BigDecimal> p) {
        long base = total / users.size(), remainder = total % users.size();
        List<Split> out = new ArrayList<>();
        for (int i = 0; i < users.size(); i++) out.add(new Split(users.get(i), base + (i < remainder ? 1 : 0))); // distribute leftover cents
        return out;
    }
}
public final class PercentSplit implements SplitStrategy {
    public List<Split> split(long total, List<String> users, Map<String, BigDecimal> pct) {
        if (pct.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add).compareTo(BigDecimal.valueOf(100)) != 0)
            throw new IllegalArgumentException("percentages must sum to 100");
        List<Split> out = new ArrayList<>(); long assigned = 0;
        for (int i = 0; i < users.size(); i++) {
            String u = users.get(i);
            long share = (i == users.size() - 1) ? total - assigned       // last one absorbs rounding
                : BigDecimal.valueOf(total).multiply(pct.get(u)).divide(BigDecimal.valueOf(100), 0, RoundingMode.DOWN).longValue();
            assigned += share; out.add(new Split(u, share));
        }
        return out;
    }
}
public final class ExactSplit implements SplitStrategy {
    public List<Split> split(long total, List<String> users, Map<String, BigDecimal> exact) {
        long sum = users.stream().mapToLong(u -> exact.get(u).longValueExact()).sum();
        if (sum != total) throw new IllegalArgumentException("exact amounts must sum to total");
        return users.stream().map(u -> new Split(u, exact.get(u).longValueExact())).toList();
    }
}

public final class BalanceSheet {
    private final Map<String, Long> net = new HashMap<>();   // >0: others owe this user
    public synchronized void apply(String payer, long total, List<Split> splits) {
        net.merge(payer, total, Long::sum);
        splits.forEach(s -> net.merge(s.userId(), -s.owedMinor(), Long::sum));
    }
    public synchronized void settle(String from, String to, long amount) { net.merge(from, amount, Long::sum); net.merge(to, -amount, Long::sum); }
    public synchronized Map<String, Long> snapshot() { return Map.copyOf(net); }
}

public record Transfer(String from, String to, long amountMinor) {}

public final class DebtSimplifier {
    /** Greedy: match the largest debtor with the largest creditor. At most n-1 transfers. */
    public List<Transfer> simplify(Map<String, Long> net) {
        PriorityQueue<Map.Entry<String, Long>> creditors = new PriorityQueue<>((a, b) -> Long.compare(b.getValue(), a.getValue()));
        PriorityQueue<Map.Entry<String, Long>> debtors = new PriorityQueue<>((a, b) -> Long.compare(a.getValue(), b.getValue()));
        net.forEach((u, v) -> { if (v > 0) creditors.add(new AbstractMap.SimpleEntry<>(u, v)); else if (v < 0) debtors.add(new AbstractMap.SimpleEntry<>(u, v)); });
        List<Transfer> out = new ArrayList<>();
        while (!creditors.isEmpty() && !debtors.isEmpty()) {
            var c = creditors.poll(); var d = debtors.poll();
            long amt = Math.min(c.getValue(), -d.getValue());
            out.add(new Transfer(d.getKey(), c.getKey(), amt));
            if (c.getValue() - amt > 0) creditors.add(new AbstractMap.SimpleEntry<>(c.getKey(), c.getValue() - amt));
            if (d.getValue() + amt < 0) debtors.add(new AbstractMap.SimpleEntry<>(d.getKey(), d.getValue() + amt));
        }
        return out;
    }
}
~~~

## Important methods explained
- {{EqualSplit}}: integer minor units, remainder cents distributed so the sum is exact (100.00 / 3 = 33.34, 33.33, 33.33).
- {{DebtSimplifier}}: greedy produces at most n-1 transfers. Finding the true minimum number of transfers is NP-hard (subset-sum); greedy is the accepted practical answer, and you should say so.

## Extensibility
Shares split (2:1:1) as a new strategy; recurring expenses; currency conversion stored with the FX rate used; itemised bills.

## Common mistakes
- {{double}} for money; splits that do not sum to the total.
- Storing only pairwise debts and recomputing everything on edit; store immutable expenses and derive balances (or maintain them transactionally).
- Claiming greedy gives the optimal minimum.

## Follow-up questions
?? How do you support editing an expense?
Treat expenses as immutable events: an edit = reversal of the old expense + a new expense. Balances are a projection you can rebuild.
?? How would you scale balances for millions of groups?
Partition by group id; maintain per-group net balances in the same transaction as the expense insert; cache the simplified plan and invalidate on change.
` },

{ id: 'ride-booking', title: 'Ride Booking System', level: 'advanced', tags: ['lld', 'strategy', 'state', 'geo'],
  summary: 'Riders, drivers, ride requests, matching strategy, fare calculation with surge, and trip state machine.',
  mock: { entities: [['Rider and Driver', 'driver'], ['Ride/Trip with status', 'trip|ride'], ['Location and geo index for nearby drivers', 'location|geo|nearby|grid|geohash'], ['Fare calculation (base, distance, time, surge)', 'fare|surge|pric'], ['Vehicle type', 'vehicle|category']], patterns: [['Strategy for matching', 'strategy.{0,40}(match|assign)|(match|assign).{0,40}strategy'], ['Strategy/decorator for fare and surge', 'surge|decorator|strategy.{0,40}fare'], ['State for trip lifecycle', 'state'], ['Observer for location / status updates', 'observer|listener|event']] },
  body: md`
## Problem statement
Design the core domain of an Uber/Careem-style app: riders request rides, the system finds a nearby available driver, the driver accepts, the trip progresses, and fare is computed with surge.

## Requirements
**Functional**
- Drivers go online/offline and stream location.
- Rider requests a ride (pickup, drop, vehicle type); system offers it to the best driver; on reject/timeout, next driver.
- Trip states: REQUESTED -> DRIVER_ASSIGNED -> ARRIVED -> IN_PROGRESS -> COMPLETED; CANCELLED from early states.
- Fare: base + per-km + per-minute, multiplied by surge for the area; minimum fare.

**Non-functional**
- A driver is assigned to at most one trip at a time (concurrency).
- Nearby search must be fast (spatial index, not scanning all drivers).
- Matching and pricing algorithms change frequently.

## Core entities
- **Rider**, **Driver** (status: OFFLINE, AVAILABLE, OFFERED, ON_TRIP; vehicle type; location).
- **Location** (lat, lng), **GeoIndex** (grid/geohash cells -> drivers).
- **Trip** (rider, driver, pickup, drop, status, fare).
- **MatchingStrategy**, **FareStrategy**, **SurgeProvider**.

## UML class diagram
~~~mermaid
classDiagram
  class Driver { +String id +VehicleType type +DriverStatus status +Location loc +tryOffer() boolean }
  class Trip { +String id +TripStatus status +Location pickup +Location drop +Money fare +transition(TripStatus) }
  class GeoIndex { +update(Driver, Location) +nearby(Location, double km) List~Driver~ }
  class MatchingStrategy { <<interface>> +rank(Trip, List~Driver~) List~Driver~ }
  class FareStrategy { <<interface>> +fare(TripMetrics, double surge) Money }
  class RideService { +request(...) Trip +accept(tripId, driverId) +complete(tripId, metrics) }
  RideService ..> GeoIndex
  RideService ..> MatchingStrategy
  RideService ..> FareStrategy
  Trip --> Driver
~~~

## Relationships
RideService depends on the geo index and strategies; Trip associates rider and driver.

## Design patterns used
- **Strategy**: matching (nearest ETA, rating-weighted, batching) and fare.
- **State**: trip and driver status transitions.
- **Observer**: location updates -> geo index; trip status -> notifications.

## Java implementation
~~~java
public enum DriverStatus { OFFLINE, AVAILABLE, OFFERED, ON_TRIP }

public final class Driver {
    private final String id; private final VehicleType type;
    private final AtomicReference<DriverStatus> status = new AtomicReference<>(DriverStatus.OFFLINE);
    private volatile Location location;
    public Driver(String id, VehicleType type) { this.id = id; this.type = type; }
    /** CAS guarantees one trip offer at a time even if two matchers pick the same driver. */
    public boolean tryOffer() { return status.compareAndSet(DriverStatus.AVAILABLE, DriverStatus.OFFERED); }
    public boolean accept()   { return status.compareAndSet(DriverStatus.OFFERED, DriverStatus.ON_TRIP); }
    public void releaseOffer(){ status.compareAndSet(DriverStatus.OFFERED, DriverStatus.AVAILABLE); }
    public void goOnline()    { status.set(DriverStatus.AVAILABLE); }
    // getters omitted
}

/** Uniform grid index: cell = floor(lat/size), floor(lng/size). Real systems use geohash/H3/S2. */
public final class GridGeoIndex {
    private final double cellDeg;
    private final ConcurrentHashMap<Long, Set<Driver>> cells = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> cellOf = new ConcurrentHashMap<>();
    public GridGeoIndex(double cellDeg) { this.cellDeg = cellDeg; }
    private long key(double lat, double lng) { return (((long) Math.floor(lat / cellDeg)) << 32) ^ (Math.floorMod((long) Math.floor(lng / cellDeg), 1L << 32)); }

    public void update(Driver d, Location l) {
        long k = key(l.lat(), l.lng());
        Long old = cellOf.put(d.id(), k);
        if (old != null && old != k) cells.getOrDefault(old, Set.of()).remove(d);
        cells.computeIfAbsent(k, x -> ConcurrentHashMap.newKeySet()).add(d);
    }
    public List<Driver> nearby(Location l, int ring) {
        List<Driver> out = new ArrayList<>();
        long cy = (long) Math.floor(l.lat() / cellDeg), cx = (long) Math.floor(l.lng() / cellDeg);
        for (long dy = -ring; dy <= ring; dy++) for (long dx = -ring; dx <= ring; dx++)
            out.addAll(cells.getOrDefault(key((cy + dy) * cellDeg, (cx + dx) * cellDeg), Set.of()));
        return out;
    }
}

public interface MatchingStrategy { List<Driver> rank(Trip trip, List<Driver> candidates); }
public final class NearestEtaMatching implements MatchingStrategy {
    private final EtaService eta;
    public NearestEtaMatching(EtaService eta) { this.eta = eta; }
    public List<Driver> rank(Trip t, List<Driver> c) {
        return c.stream().filter(d -> d.type() == t.vehicleType() && d.status() == DriverStatus.AVAILABLE)
                .sorted(Comparator.comparing(d -> eta.estimate(d.location(), t.pickup()))).limit(5).toList();
    }
}

public interface FareStrategy { Money fare(TripMetrics m, BigDecimal surge); }
public final class StandardFare implements FareStrategy {
    private final Money base, perKm, perMin, minimum;
    // constructor omitted
    public Money fare(TripMetrics m, BigDecimal surge) {
        Money raw = base.plus(perKm.times(m.km())).plus(perMin.times(m.minutes())).times(surge);
        return raw.max(minimum);
    }
}

public final class RideService {
    private final GridGeoIndex geo; private final MatchingStrategy matching; private final OfferSender offers;
    // constructor omitted
    public Optional<Driver> dispatch(Trip trip) {
        for (Driver d : matching.rank(trip, geo.nearby(trip.pickup(), 2))) {
            if (!d.tryOffer()) continue;                              // someone else grabbed this driver
            if (offers.offerAndAwait(d, trip, Duration.ofSeconds(15))) {
                if (d.accept()) { trip.assign(d); return Optional.of(d); }
            }
            d.releaseOffer();                                         // declined or timed out
        }
        return Optional.empty();                                     // widen radius or report no drivers
    }
}
~~~

## Important methods explained
- {{Driver.tryOffer}}: compare-and-set from AVAILABLE to OFFERED, so concurrent dispatchers never double-offer the same driver.
- {{GridGeoIndex.nearby}}: checks the cell and its neighbours; O(drivers in ~9-25 cells) instead of O(all drivers).
- {{StandardFare}}: surge applied as a multiplier; minimum fare enforced last.

## Extensibility
Pooling (multiple riders per trip) changes Trip to have multiple legs; scheduled rides add a SCHEDULED state; new fare models (flat airport fare) are strategies selected by rules.

## Common mistakes
- Scanning all drivers for every request.
- Offering one ride to many drivers simultaneously without a way to resolve multiple accepts.
- Computing fare from straight-line distance instead of actual route metrics.

## Follow-up questions
?? How does this become distributed?
Driver locations live in Redis GEO / an in-memory geo service sharded by city/region; driver status CAS becomes a Redis/DB conditional update; offers go over WebSocket/push with timeouts. See the Uber system design.
?? How do you compute surge?
Per geo cell, ratio of open requests to available drivers over a sliding window, smoothed and capped, recomputed every ~30-60s. Store the surge applied on the trip so the fare is reproducible.
` }
]);
})();
