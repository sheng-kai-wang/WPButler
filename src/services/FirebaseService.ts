import { initializeApp } from "firebase/app";
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  DocumentData,
  DocumentReference,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  Timestamp,
  Unsubscribe,
  updateDoc,
  where,
} from "firebase/firestore";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  User,
} from "firebase/auth";
import Config from "../../Config";
import ClassTime from "../entities/ClassTime";
import { ClassroomQueue, QueueItem } from "../entities/ClassroomQueue";

export default class FirebaseService {
  private static instance: FirebaseService;
  static get Instance() {
    if (!FirebaseService.instance)
      FirebaseService.instance = new FirebaseService();
    return FirebaseService.instance;
  }
  private constructor() {
    initializeApp(Config.firebaseConfig);
    this.auth = getAuth();
    this.db = getFirestore();
    this.queryDatabase();
    this.startTimer();
    this.listenSnapshots();
  }
  private auth;
  private db;

  private previousSessionState: boolean = false;
  private classTime?: { id: string; data: ClassTime } | null;
  private classTimeChangedListeners: ((
    isSessionAlive: boolean,
    classTime?: ClassTime
  ) => void)[] = [];
  private currentQueue?: ClassroomQueue;

  private async queryDatabase() {
    const classTimeQ = query(
      collection(this.db, "class-time"),
      where("end", ">=", Timestamp.now())
    );
    const classTimeQR = await getDocs(classTimeQ);
    if (classTimeQR.empty) FirebaseService.Instance.classTime = null;
    classTimeQR.forEach((doc) => {
      const data = doc.data() as ClassTime;
      if (data.start.toMillis() <= Timestamp.now().toMillis()) {
        FirebaseService.Instance.classTime = { id: doc.id, data };
      }
    });
  }

  private async startTimer() {
    setInterval(() => {
      const currentSessionState = FirebaseService.Instance.isClassTimeValid();
      if (
        FirebaseService.Instance.previousSessionState !== currentSessionState
      ) {
        FirebaseService.Instance.previousSessionState = currentSessionState;
        FirebaseService.Instance.classTimeChangedListeners.forEach((e) =>
          e(currentSessionState, FirebaseService.Instance.classTime?.data)
        );
      }
    }, 1000);
  }

  private async listenSnapshots() {
    await this.isDataReady();
    if (FirebaseService.Instance.classTime) {
      onSnapshot(
        doc(
          FirebaseService.Instance.db,
          "class-time",
          FirebaseService.Instance.classTime.id
        ),
        (doc) => {
          if (FirebaseService.Instance.classTime)
            FirebaseService.Instance.classTime.data = doc.data() as ClassTime;
        }
      );
    }
    FirebaseService.Instance.onClassroomQueueChanged((classroomQueue) => {
      FirebaseService.Instance.currentQueue = classroomQueue;
    });
  }

  private isClassTimeValid(): boolean {
    if (!FirebaseService.Instance.classTime) return false;
    let start = FirebaseService.Instance.classTime.data.start;
    return (
      start.toMillis() <= Timestamp.now().toMillis() &&
      FirebaseService.Instance.classTime.data.end.toMillis() >=
        Timestamp.now().toMillis()
    );
  }

  isDataReady() {
    return new Promise<void>((res) => {
      const timer = setInterval(() => {
        if (FirebaseService.Instance.classTime !== undefined) {
          clearInterval(timer);
          FirebaseService.Instance.previousSessionState =
            FirebaseService.Instance.isClassTimeValid();
          res();
        }
      }, 10);
    });
  }

  async createAccount(
    email: string,
    password: string = "soselab401"
  ): Promise<boolean> {
    try {
      await createUserWithEmailAndPassword(
        FirebaseService.Instance.auth,
        email,
        password
      );
    } catch (error) {
      console.error(error);
      return false;
    }
    return true;
  }

  async signIn(email: string, password: string): Promise<User | null> {
    if (FirebaseService.Instance.currentUser)
      return FirebaseService.Instance.currentUser;
    try {
      await signInWithEmailAndPassword(
        FirebaseService.Instance.auth,
        email,
        password
      );
    } catch (error) {
      console.error(error);
    }
    return FirebaseService.Instance.currentUser;
  }

  async signOut() {
    await FirebaseService.Instance.auth.signOut();
  }

  get currentUser(): User | null {
    return FirebaseService.Instance.auth.currentUser;
  }

  get hasLogin(): Promise<boolean> {
    return new Promise<boolean>((res) =>
      FirebaseService.Instance.auth.onAuthStateChanged((user) => res(!!user))
    );
  }

  private get currentClassroomQueueRef(): DocumentReference<DocumentData> | null {
    if (!FirebaseService.Instance.classTime) return null;
    return doc(
      FirebaseService.Instance.db,
      "classroom-queue",
      FirebaseService.Instance.classTime.id
    );
  }

  onAuthStateChanged(
    callback: (hasLogin: boolean) => void,
    activateOn: (hasLogin: boolean) => boolean
  ): Unsubscribe {
    return FirebaseService.Instance.auth.onAuthStateChanged(
      (user) => activateOn(!!user) && callback(!!user)
    );
  }

  onClassTimeChanged(
    onEmit: (isSessionAlive: boolean, classTime?: ClassTime) => void
  ): () => void {
    (async () => {
      await FirebaseService.Instance.isDataReady();
      onEmit(
        FirebaseService.Instance.isClassTimeValid(),
        FirebaseService.Instance.classTime?.data
      );
      FirebaseService.Instance.classTimeChangedListeners.push(onEmit);
    })();
    return () => {
      const onEmitRef = onEmit;
      FirebaseService.Instance.classTimeChangedListeners =
        FirebaseService.Instance.classTimeChangedListeners.filter(
          (f) => f !== onEmitRef
        );
    };
  }

  async onClassroomQueueChanged(
    onEmit: (classroomQueue?: ClassroomQueue) => void
  ): Promise<Unsubscribe | null> {
    await FirebaseService.Instance.isDataReady();
    const ref = FirebaseService.Instance.currentClassroomQueueRef;
    if (ref) {
      return onSnapshot(ref, (doc) => {
        if (doc.exists()) {
          const queue = doc.data() as ClassroomQueue;
          queue.queue.sort(
            (a, b) => a.appliedAt.toMillis() - b.appliedAt.toMillis()
          );
          onEmit(queue);
        } else onEmit();
      });
    }
    return null;
  }

  async enqueue(item: QueueItem) {
    const ref = FirebaseService.Instance.currentClassroomQueueRef;
    if (!ref) return;
    await updateDoc(ref, {
      queue: arrayUnion(item),
    });
  }

  async dequeue(id: string) {
    if (!FirebaseService.Instance.currentQueue) return;
    const res = FirebaseService.Instance.currentQueue.queue.find(
      (q) => q.id === id
    );
    const ref = FirebaseService.Instance.currentClassroomQueueRef;
    if (!ref || !res) return;
    await updateDoc(ref, {
      queue: arrayRemove(res),
    });
  }

  async dequeueAndEnqueueResolved(points: number) {
    if (!FirebaseService.Instance.currentQueue) return;
    const res = FirebaseService.Instance.currentQueue.queue[0];
    const ref = FirebaseService.Instance.currentClassroomQueueRef;
    if (!ref || !res) return;
    await updateDoc(ref, {
      queue: arrayRemove(res),
      resolved: arrayUnion({
        id: res.id,
        points,
        resolvedAt: Timestamp.now(),
      }),
    });
  }

  async enqueueResolve(id: string, points: number) {
    const ref = FirebaseService.Instance.currentClassroomQueueRef;
    if (!ref) return;
    await updateDoc(ref, {
      resolved: arrayUnion({
        id,
        points,
        resolvedAt: Timestamp.now(),
      }),
    });
  }
}
